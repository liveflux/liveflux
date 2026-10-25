import { ConnectionManager, type HeartbeatPolicy } from '../internal/connection/connection-manager';
import type { ReconnectPolicy } from '../internal/connection/reconnect';
import { SubscriptionRegistry } from '../internal/subscriptions/subscription-registry';
import { Store, type IntoStrategy } from '../internal/store/store';
import type { ConnectionState, NormalizedEvent, ReplyFrame, StreamAdapter } from '../types';
import { BackpressureError, ConnectionError, RequestError, TimeoutError } from '../errors';

/** Default request timeout (ms) when neither the client nor the call overrides it. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** A publish/request queued in the offline outbox while the connection is not open. */
interface OutboxEntry {
  /** Epoch ms when queued — used for TTL expiry on flush. */
  enqueuedAt: number;
  /** Perform the deferred send (called on reopen, in FIFO order). */
  flush: () => void;
  /** Called if the entry is discarded before it can be sent (overflow / TTL / client close). */
  drop: (reason: unknown) => void;
}

/** Default cap for the offline outbox when enabled without an explicit `maxSize`. */
const DEFAULT_OUTBOX_MAX_SIZE = 100;

export interface LivefluxClientOptions {
  /** The protocol adapter (WebSocket, Phoenix Channels, …). */
  adapter: StreamAdapter;
  /** Reconnection tuning (exponential backoff + jitter). */
  reconnect?: Partial<ReconnectPolicy>;
  /** Heartbeat keepalive tuning. */
  heartbeat?: Partial<HeartbeatPolicy>;
  /** Default timeout (ms) for `request` when a call doesn't set its own. Default 30000. */
  requestTimeoutMs?: number;
  /**
   * Opt-in offline outbox. When set, `publish` / `request` issued while the connection is not open
   * are queued and flushed (FIFO) on reopen, instead of throwing/rejecting immediately. Omit to keep
   * the default reject-when-closed behavior.
   */
  offline?: OfflinePolicy;
  /**
   * Max concurrent in-flight `request`s. A request that would exceed the cap (at send time) rejects
   * with a `BackpressureError`. Default: unlimited.
   */
  maxInFlightRequests?: number;
}

/** Configuration for the opt-in offline outbox ({@link LivefluxClientOptions.offline}). */
export interface OfflinePolicy {
  /**
   * Maximum queued messages. On overflow the oldest is dropped (a dropped request rejects with a
   * `ConnectionError`). Default 100.
   */
  maxSize?: number;
  /**
   * Drop a queued message once it has waited longer than this (ms), checked at flush time (a dropped
   * request rejects with a `TimeoutError`). Default: no expiry.
   */
  ttlMs?: number;
}

/** Options for a fire-and-forget {@link LivefluxClient.publish}. */
export interface PublishOptions {
  /** Out-of-band metadata forwarded verbatim to the server (correlation ids, headers, …). */
  meta?: Record<string, unknown>;
  /** Key the server can use to dedupe this command if it's delivered more than once. */
  idempotencyKey?: string;
}

/** Options for a request/response {@link LivefluxClient.request}. */
export interface RequestOptions {
  /** Reject with a `TimeoutError` after this many ms. Overrides the client default. */
  timeoutMs?: number;
  /** Abort the request early — rejects the promise and stops tracking the reply. */
  signal?: AbortSignal;
  /** Out-of-band metadata forwarded verbatim to the server. */
  meta?: Record<string, unknown>;
  /** Key the server can use to dedupe this request if it's delivered more than once. */
  idempotencyKey?: string;
}

/** Declarative subscription config: a channel plus how its events fold into state. */
export interface SubscribeConfig<T, S = T> {
  channel: string;
  into: IntoStrategy<T, S>;
  /** Extra params forwarded to the adapter's subscribe frame. */
  params?: Record<string, unknown>;
}

/** A stateful subscription — the folded state plus how to observe and tear it down. */
export interface Subscription<T, S = T> {
  /** Current derived state (shape depends on the strategy). */
  getState(): T[] | T | S | undefined;
  /** Subscribe to state changes; returns an unsubscribe fn (drives `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Stop folding events and release the underlying wire subscription. */
  destroy(): void;
}

/** A snapshot of one active subscription, handed to an observer's `onSubscriptionAdd`. */
export interface ObservedSubscription {
  readonly id: string;
  readonly channel: string;
  readonly strategy: string;
  readonly cap?: number;
  readonly refCount: number;
}

/** A fire-and-forget command as it is issued, handed to an observer's `onPublish`. */
export interface ObservedPublish {
  readonly channel: string;
  readonly event: string;
  /** The raw payload — a tap redacts it before display; never mutate it. */
  readonly payload: unknown;
  readonly meta?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  /** `true` when it was held in the offline outbox (connection not open) rather than sent now. */
  readonly queued: boolean;
}

/** A request as it is issued, handed to an observer's `onRequest`; settles later via `onRequestSettle`. */
export interface ObservedRequest {
  readonly requestId: string;
  readonly channel: string;
  readonly event: string;
  /** The raw payload — a tap redacts it before display; never mutate it. */
  readonly payload: unknown;
  readonly meta?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  /** `true` when it was held in the offline outbox (connection not open) rather than sent now. */
  readonly queued: boolean;
}

/** How a request finished. */
export type RequestOutcome = 'resolved' | 'rejected';

/** The terminal state of a request, handed to an observer's `onRequestSettle` (correlated by id). */
export interface ObservedRequestSettle {
  readonly requestId: string;
  readonly outcome: RequestOutcome;
  /** Present on a resolved request — the raw reply payload (a tap redacts it). */
  readonly payload?: unknown;
  /** Present on a rejected request — the error (a `LivefluxError` subclass, an abort reason, …). */
  readonly error?: unknown;
}

/**
 * The observability tap. A tool (e.g. `@liveflux/devtools`) implements the methods it cares about and
 * attaches via {@link LivefluxClient.observe}; the client fans lifecycle out to it. Every method is
 * optional, and the whole surface is inert when nothing is attached — the tap costs nothing in
 * production, and the heavy machinery (buffering, redaction, discovery, UI) lives entirely in the
 * dev-only tooling package, never in core.
 */
export interface ClientObserver {
  onConnectionState?(state: ConnectionState, previous: ConnectionState): void;
  onError?(err: unknown): void;
  onSubscriptionAdd?(sub: ObservedSubscription): void;
  onSubscriptionRefChange?(id: string, refCount: number): void;
  onSubscriptionRemove?(id: string): void;
  onEvent?(event: NormalizedEvent): void;
  /** A fire-and-forget command was issued (client→server). */
  onPublish?(command: ObservedPublish): void;
  /** A request was issued (client→server RPC); it later settles via {@link onRequestSettle}. */
  onRequest?(request: ObservedRequest): void;
  /** A previously-issued request settled (resolved with a reply, or rejected). */
  onRequestSettle?(settle: ObservedRequestSettle): void;
}

/**
 * A "why isn't my stream working?" snapshot from {@link LivefluxClient.diagnose}. Pull-based and
 * side-effect-free — it reads current state on demand, so it adds no passive runtime cost.
 */
export interface DiagnosisReport {
  readonly channel: string;
  readonly connectionState: ConnectionState;
  /** Whether an active wire subscription exists for the channel. */
  readonly subscribed: boolean;
  /** Number of live listeners folding this channel. */
  readonly listenerCount: number;
  /** Human-readable, actionable checks — most-likely cause first. */
  readonly hints: string[];
}

/** A ref-counted fold shared by every identical subscription. */
interface SharedFold {
  store: Store<unknown, unknown>;
  release: () => void; // registry unsubscribe for this fold's wire listener
  refs: number;
  /** Observability id, assigned lazily the first time an observer needs to name this fold. */
  obsId: string;
}

/** Monotonic id source for observed subscriptions; only ever used while an observer is attached. */
let subSeq = 0;

/** The `cap` of an into-strategy, if it has one (`append`/`upsert`). */
function capOf<T, S>(into: IntoStrategy<T, S>): number | undefined {
  return 'cap' in into ? into.cap : undefined;
}

/**
 * The context layer for `@liveflux/core`.
 *
 * Composes the connection lifecycle, the subscription registry, and per-subscription stores behind
 * a single surface. Consumers and framework bindings talk **only** to this — `ConnectionManager`,
 * `SubscriptionRegistry`, and `Store` are internal implementation details.
 *
 * A dev-only tool can attach a {@link ClientObserver} via {@link observe} to inspect lifecycle; the
 * tap is inert (zero cost) when nothing is attached.
 */
export class LivefluxClient {
  readonly #connection: ConnectionManager;
  readonly #registry: SubscriptionRegistry;
  /** Ref-counted shared folds keyed by {@link shareKey} — identical subscriptions fold once. */
  readonly #shared = new Map<string, SharedFold>();
  /** Attached observers (usually zero; one when a DevTools panel is present). */
  readonly #observers = new Set<ClientObserver>();
  /** In-flight requests awaiting a reply, keyed by requestId. */
  readonly #pending = new Map<string, PendingRequest>();
  /** Monotonic per-client request counter — requestIds only need to be unique within this client. */
  #nextReqId = 0;
  readonly #defaultTimeoutMs: number;
  /** Resolved offline-outbox config, or `null` when the outbox is disabled (reject-when-closed). */
  readonly #offline: { maxSize: number; ttlMs: number } | null;
  /** The offline outbox — insertion-ordered (FIFO) so flush + drop-oldest are trivial. */
  readonly #outbox = new Map<string, OutboxEntry>();
  /** Monotonic counter for publish outbox keys (requests key the outbox by their requestId). */
  #nextOutboxId = 0;
  /** Max concurrent in-flight requests; `Infinity` when uncapped. */
  readonly #maxInFlight: number;

  constructor(opts: LivefluxClientOptions) {
    this.#defaultTimeoutMs =
      opts.requestTimeoutMs && opts.requestTimeoutMs > 0
        ? opts.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
    this.#offline = opts.offline
      ? {
          maxSize:
            opts.offline.maxSize && opts.offline.maxSize > 0
              ? opts.offline.maxSize
              : DEFAULT_OUTBOX_MAX_SIZE,
          ttlMs: opts.offline.ttlMs && opts.offline.ttlMs > 0 ? opts.offline.ttlMs : Infinity,
        }
      : null;
    this.#maxInFlight =
      opts.maxInFlightRequests && opts.maxInFlightRequests > 0
        ? opts.maxInFlightRequests
        : Infinity;
    this.#registry = new SubscriptionRegistry(opts.adapter);
    this.#connection = new ConnectionManager({
      adapter: opts.adapter,
      reconnect: opts.reconnect,
      heartbeat: opts.heartbeat,
      onEvent: (event) => {
        this.#registry.handleEvent(event);
        if (this.#observers.size) {
          for (const observer of this.#observers) {
            try {
              observer.onEvent?.(event);
            } catch {
              // isolate observer failures — observability must never break the client
            }
          }
        }
      },
      onReply: (reply) => this.#handleReply(reply),
    });
    this.#connection.onStateChange((state) => {
      if (state === 'open') {
        // Reopened — send anything that queued while we were offline, in FIFO order.
        this.#flushOutbox();
      } else if (state === 'reconnecting' || state === 'closed') {
        // A *sent* request can't complete once the link leaves `open` — reject it so callers see a
        // ConnectionError instead of hanging until timeout. *Queued* (outbox) entries are left alone
        // to flush on the next reopen — except on a permanent close, where they're dropped too.
        this.#rejectAllPending(
          new ConnectionError('Connection dropped before the request completed.'),
        );
        if (state === 'closed') {
          this.#clearOutbox(
            new ConnectionError('Client closed before the queued message could be sent.'),
          );
        }
      }
    });
    // Tamper-proof public surface: methods can't be reassigned/shadowed. Internal collaborators
    // are `#private` (runtime-encapsulated), unreachable from outside regardless.
    Object.freeze(this);
  }

  #handleReply(reply: ReplyFrame): void {
    const pending = this.#pending.get(reply.requestId);
    if (!pending) return; // unknown, or already settled (timed out / aborted) — ignore
    this.#pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
    if (reply.ok) {
      pending.resolve(reply.payload);
    } else {
      pending.reject(
        new RequestError(reply.error?.message ?? 'The server rejected the request.', {
          serverCode: reply.error?.code,
          data: reply.error?.data,
        }),
      );
    }
  }

  #rejectAllPending(reason: unknown): void {
    if (this.#pending.size === 0) return;
    const inflight = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of inflight) {
      clearTimeout(p.timer);
      if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
      p.reject(reason);
    }
  }

  /** Queue an outbox entry, evicting the oldest (drop-oldest) when at capacity. */
  #enqueue(id: string, entry: OutboxEntry): void {
    if (!this.#offline) return;
    while (this.#outbox.size >= this.#offline.maxSize) {
      const oldest = this.#outbox.keys().next().value; // insertion order → the oldest key
      if (oldest === undefined) break;
      const evicted = this.#outbox.get(oldest)!;
      this.#outbox.delete(oldest);
      evicted.drop(
        new ConnectionError('Offline outbox is full — the oldest queued message was dropped.'),
      );
    }
    this.#outbox.set(id, entry);
  }

  /** Flush the outbox in FIFO order on reopen, dropping entries that outlived the TTL. */
  #flushOutbox(): void {
    if (this.#outbox.size === 0) return;
    const now = Date.now();
    const ttlMs = this.#offline?.ttlMs ?? Infinity;
    const entries = [...this.#outbox.values()];
    this.#outbox.clear();
    for (const entry of entries) {
      if (now - entry.enqueuedAt > ttlMs) {
        entry.drop(
          new TimeoutError('A queued message expired (offline TTL) before the connection reopened.'),
        );
      } else {
        entry.flush();
      }
    }
  }

  /** Drop every queued entry (e.g. on permanent close), rejecting queued requests. */
  #clearOutbox(reason: unknown): void {
    if (this.#outbox.size === 0) return;
    const entries = [...this.#outbox.values()];
    this.#outbox.clear();
    for (const entry of entries) entry.drop(reason);
  }

  /** Open the connection. No-op while already connecting/open. */
  connect(): void {
    this.#connection.connect();
  }

  /** Current connection state. */
  getConnectionState(): ConnectionState {
    return this.#connection.getState();
  }

  /**
   * Send a fire-and-forget command to the server (client→server). At-most-once: sent once over the
   * open connection, no reply awaited. When the connection is not open: if the offline outbox is
   * enabled the command is queued and flushed on reopen; otherwise this throws a `ConnectionError`
   * (or if the transport has no publish path).
   */
  publish(channel: string, event: string, payload: unknown, opts?: PublishOptions): void {
    const frame = { channel, event, payload, meta: opts?.meta, idempotencyKey: opts?.idempotencyKey };
    const open = this.#connection.getState() === 'open';
    // Sent now when open (or when closed without an outbox, where connection.publish then throws);
    // queued only when closed AND the offline outbox is enabled.
    const queued = !open && !!this.#offline;
    this.#emitPublish({
      channel,
      event,
      payload,
      ...(opts?.meta !== undefined ? { meta: opts.meta } : {}),
      ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      queued,
    });
    if (open || !this.#offline) {
      this.#connection.publish(frame);
      return;
    }
    // Closed + outbox enabled → queue; fire-and-forget, so nothing to reject if it's later dropped.
    this.#enqueue(`out-${(this.#nextOutboxId += 1)}`, {
      enqueuedAt: Date.now(),
      flush: () => this.#connection.publish(frame),
      drop: () => {},
    });
  }

  /**
   * Send a request to the server and await its correlated reply (client→server RPC). Resolves with
   * the server's payload, or rejects with: a `TimeoutError` if no reply arrives in time, a
   * `RequestError` if the server rejects it, a `ConnectionError` if the link isn't open / can't do
   * requests / drops mid-flight, or the abort reason if `opts.signal` fires.
   */
  request<Res = unknown>(
    channel: string,
    event: string,
    payload: unknown,
    opts?: RequestOptions,
  ): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('The request was aborted.'));
        return;
      }
      const requestId = `req-${(this.#nextReqId += 1)}`;
      const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : this.#defaultTimeoutMs;

      // Single observability choke point: every settle path (reply, timeout, abort, backpressure,
      // outbox drop, connection drop) funnels through these, so `onRequestSettle` fires exactly once.
      let settled = false;
      const finishObserve = (outcome: RequestOutcome, detail: { payload?: unknown; error?: unknown }): void => {
        if (settled) return;
        settled = true;
        this.#emitRequestSettle({ requestId, outcome, ...detail });
      };
      const wrappedResolve = (value: unknown): void => {
        finishObserve('resolved', { payload: value });
        resolve(value as Res);
      };
      const wrappedReject = (err: unknown): void => {
        finishObserve('rejected', { error: err });
        reject(err);
      };

      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      // A request lives in exactly one of #outbox (queued) or #pending (sent); both deletes are
      // idempotent, so settling from either state is a single safe call.
      const settle = (): void => {
        this.#outbox.delete(requestId);
        this.#pending.delete(requestId);
        cleanup();
      };
      const onAbort = (): void => {
        settle();
        wrappedReject(signal?.reason ?? new Error('The request was aborted.'));
      };
      // Timeout is the total budget from this call — it spans any queue time, then the wait for a reply.
      timer = setTimeout(() => {
        settle();
        wrappedReject(new TimeoutError(`Request to "${channel}" (${event}) timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      const frame = {
        requestId,
        channel,
        event,
        payload,
        meta: opts?.meta,
        idempotencyKey: opts?.idempotencyKey,
      };
      const send = (): void => {
        if (this.#pending.size >= this.#maxInFlight) {
          this.#outbox.delete(requestId); // if it came via a flush
          settle();
          wrappedReject(
            new BackpressureError(
              `Too many in-flight requests (max ${this.#maxInFlight}); "${channel}" was refused.`,
            ),
          );
          return;
        }
        this.#pending.set(requestId, {
          resolve: wrappedResolve,
          reject: wrappedReject,
          timer,
          signal,
          onAbort,
        });
        try {
          this.#connection.request(frame);
        } catch (err) {
          // no publish path / raced to non-open — undo and surface the error
          this.#pending.delete(requestId);
          cleanup();
          wrappedReject(err);
        }
      };

      const state = this.#connection.getState();
      // Announce the issued request before dispatch, so a synchronous settle (backpressure, no publish
      // path) is always ordered after its `onRequest`.
      this.#emitRequest({
        requestId,
        channel,
        event,
        payload,
        ...(opts?.meta !== undefined ? { meta: opts.meta } : {}),
        ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        queued: state !== 'open' && !!this.#offline,
      });
      if (state === 'open') {
        send();
      } else if (this.#offline) {
        // Closed + outbox enabled → queue; flush sends it on reopen, drop rejects if discarded.
        this.#enqueue(requestId, {
          enqueuedAt: Date.now(),
          flush: send,
          drop: (reason) => {
            cleanup();
            wrappedReject(reason);
          },
        });
      } else {
        cleanup();
        wrappedReject(
          new ConnectionError(`Cannot send request to "${channel}": connection is ${state}, not open.`),
        );
      }
    });
  }

  /** Subscribe to connection-state transitions. Returns an unsubscribe function. */
  onConnectionChange(
    listener: (state: ConnectionState, previous: ConnectionState) => void,
  ): () => void {
    return this.#connection.onStateChange(listener);
  }

  /**
   * Subscribe to adapter/connection errors. Returns an unsubscribe function. Errors are surfaced
   * to every listener with the same isolation as the other observers — a throwing listener never
   * breaks the dispatch or the connection state machine.
   */
  onError(listener: (err: unknown) => void): () => void {
    return this.#connection.onError(listener);
  }

  /**
   * Attach an observability tap (used by `@liveflux/devtools`). Connection-state and error hooks are
   * wired through the existing listener infrastructure; subscription and event hooks fire from the
   * folding path. Returns a function that fully detaches the observer. Attach before subscribing to
   * see every subscription — pre-existing folds are announced on their next interaction, not replayed.
   */
  observe(observer: ClientObserver): () => void {
    const offs: Array<() => void> = [];
    if (observer.onConnectionState)
      offs.push(this.#connection.onStateChange(observer.onConnectionState));
    if (observer.onError) offs.push(this.#connection.onError(observer.onError));
    this.#observers.add(observer);
    offs.push(() => {
      this.#observers.delete(observer);
    });
    return () => {
      for (const off of offs) off();
    };
  }

  /**
   * Subscribe to a channel and fold its events into state via the chosen strategy. The wire
   * subscription is multiplexed + ref-counted; the returned `Subscription` exposes the derived
   * state (`getState`), a change subscription (`subscribe`), and teardown (`destroy`).
   *
   * Identical subscriptions (same channel + serializable strategy + params) **share one fold** —
   * the events are folded once and every subscriber reads the same store, ref-counted so the fold
   * (and its wire subscription) is released only when the last subscriber leaves. Configs with
   * functions (`reducer`, function `upsert` key) get a private fold.
   */
  subscribe<T, S = T>(config: SubscribeConfig<T, S>): Subscription<T, S> {
    const key = shareKey(config);
    if (key === null) return this.#privateSubscribe(config); // not shareable → own fold

    let fold = this.#shared.get(key);
    if (!fold) {
      const store = new Store(config.into as unknown as IntoStrategy<unknown, unknown>);
      const release = this.#registry.subscribe(
        config.channel,
        (event) => store.apply(event),
        config.params,
      );
      fold = { store, release, refs: 0, obsId: '' };
      this.#shared.set(key, fold);
      if (this.#observers.size) {
        fold.obsId = `sub-${(subSeq += 1)}`;
        this.#emitSubAdd(fold.obsId, config, 1);
      }
    } else if (this.#observers.size) {
      if (fold.obsId === '') {
        // Fold predates the observer — announce it now rather than emit a ref-change for no `add`.
        fold.obsId = `sub-${(subSeq += 1)}`;
        this.#emitSubAdd(fold.obsId, config, fold.refs + 1);
      } else {
        this.#emitSubRefChange(fold.obsId, fold.refs + 1);
      }
    }
    fold.refs += 1;
    const shared = fold;
    // Identical keys imply identical runtime payload types by construction — a controlled cast.
    const store = shared.store as unknown as Store<T, S>;
    let released = false;
    return Object.freeze({
      getState: () => store.getState(),
      subscribe: (listener: () => void) => store.subscribe(listener),
      destroy: () => {
        if (released) return; // idempotent per handle
        released = true;
        shared.refs -= 1;
        if (shared.refs === 0) {
          shared.release();
          this.#shared.delete(key);
          if (shared.obsId !== '') this.#emitSubRemove(shared.obsId);
        } else if (shared.obsId !== '') {
          this.#emitSubRefChange(shared.obsId, shared.refs);
        }
      },
    });
  }

  /** An unshared fold — its own store + wire listener. Used when a config can't be keyed. */
  #privateSubscribe<T, S>(config: SubscribeConfig<T, S>): Subscription<T, S> {
    const store = new Store<T, S>(config.into);
    const off = this.#registry.subscribe(
      config.channel,
      (event) => store.apply(event),
      config.params,
    );
    let obsId = '';
    if (this.#observers.size) {
      obsId = `sub-${(subSeq += 1)}`;
      this.#emitSubAdd(obsId, config, 1);
    }
    let released = false;
    // Frozen so the returned handle can't be tampered with (its methods reassigned) by a consumer.
    return Object.freeze({
      getState: () => store.getState(),
      subscribe: (listener: () => void) => store.subscribe(listener),
      destroy: () => {
        if (released) return; // idempotent per handle
        released = true;
        off();
        if (obsId !== '') this.#emitSubRemove(obsId);
      },
    });
  }

  /**
   * Explain the current state of a channel — connection state, whether it's subscribed, and
   * actionable hints for the most common realtime footguns (forgot to connect, wrong channel name,
   * connection dropped). On-demand and side-effect-free; safe to call from a console or error handler.
   */
  diagnose(channel: string): DiagnosisReport {
    const connectionState = this.#connection.getState();
    const listenerCount = this.#registry.listenerCount(channel);
    const subscribed = listenerCount > 0;
    const hints: string[] = [];
    switch (connectionState) {
      case 'idle':
        hints.push('Connection is idle — call client.connect() to open it.');
        break;
      case 'connecting':
        hints.push('Connection is still opening; events flow once it is open.');
        break;
      case 'reconnecting':
        hints.push('Connection dropped and is reconnecting; streams resume on reopen.');
        break;
      case 'closed':
        hints.push('Connection is closed and not reconnecting.');
        break;
    }
    if (!subscribed) {
      hints.push(
        `No active subscription for "${channel}" — check the channel name matches the server and that a subscribe()/useStream for it is mounted.`,
      );
    } else if (connectionState === 'open') {
      hints.push(
        `Subscribed and connected; if no events arrive, verify the server publishes to "${channel}".`,
      );
    }
    return { channel, connectionState, subscribed, listenerCount, hints };
  }

  /** Tear everything down: unsubscribe every channel and close the connection. */
  destroy(): void {
    this.#shared.clear(); // wires are torn down by registry.clear() below
    this.#registry.clear();
    this.#connection.close();
  }

  #emitSubAdd<T, S>(id: string, config: SubscribeConfig<T, S>, refCount: number): void {
    const sub: ObservedSubscription = {
      id,
      channel: config.channel,
      strategy: config.into.strategy,
      cap: capOf(config.into),
      refCount,
    };
    for (const observer of this.#observers) {
      try {
        observer.onSubscriptionAdd?.(sub);
      } catch {
        // isolate observer failures
      }
    }
  }

  #emitSubRefChange(id: string, refCount: number): void {
    for (const observer of this.#observers) {
      try {
        observer.onSubscriptionRefChange?.(id, refCount);
      } catch {
        // isolate observer failures
      }
    }
  }

  #emitSubRemove(id: string): void {
    for (const observer of this.#observers) {
      try {
        observer.onSubscriptionRemove?.(id);
      } catch {
        // isolate observer failures
      }
    }
  }

  #emitPublish(command: ObservedPublish): void {
    if (this.#observers.size === 0) return;
    for (const observer of this.#observers) {
      try {
        observer.onPublish?.(command);
      } catch {
        // isolate observer failures
      }
    }
  }

  #emitRequest(request: ObservedRequest): void {
    if (this.#observers.size === 0) return;
    for (const observer of this.#observers) {
      try {
        observer.onRequest?.(request);
      } catch {
        // isolate observer failures
      }
    }
  }

  #emitRequestSettle(settle: ObservedRequestSettle): void {
    if (this.#observers.size === 0) return;
    for (const observer of this.#observers) {
      try {
        observer.onRequestSettle?.(settle);
      } catch {
        // isolate observer failures
      }
    }
  }
}

/**
 * A stable identity for a subscription config, or `null` when it can't be shared safely. Configs
 * carrying functions (a `reducer`, or an `upsert` with a function key) or non-serializable params
 * are never shared — each gets its own private fold — since function identity can't be keyed.
 */
function shareKey<T, S>(config: SubscribeConfig<T, S>): string | null {
  const into = config.into;
  let sig: string;
  switch (into.strategy) {
    case 'append':
      sig = `a:${into.cap ?? ''}`;
      break;
    case 'replace':
      sig = 'r';
      break;
    case 'upsert':
      if (typeof into.key === 'function') return null; // function key → identity-dependent
      sig = `u:${String(into.key)}:${into.cap ?? ''}`;
      break;
    default:
      return null; // 'reducer' carries functions → never shared
  }
  let params = '';
  if (config.params !== undefined) {
    try {
      params = JSON.stringify(config.params);
    } catch {
      return null; // non-serializable params → don't share
    }
  }
  return `${config.channel} ${sig} ${params}`;
}
