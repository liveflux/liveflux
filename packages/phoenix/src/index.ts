import type {
  AdapterHandlers,
  NormalizedEvent,
  StreamAdapter,
  SubscribeRequest,
} from '@liveflux/core';
import { Outbox, type Sink } from './internal/outbox';

/** Host `setTimeout`/`clearTimeout` without pulling in DOM/Node lib types. */
const timers = globalThis as {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/**
 * Arm a one-shot timer and `unref` it where supported (Node) so a background join/rejoin timer
 * never keeps a process alive on its own. A no-op cast in the browser, where the handle is a number.
 */
function arm(ms: number, cb: () => void): unknown {
  const handle = timers.setTimeout(cb, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

/** A minimal WebSocket-like object (browser WebSocket, Node `ws`, or a test double). */
interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  /** Bytes queued but not yet transmitted; used for outbound backpressure. Optional. */
  readonly bufferedAmount?: number;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/**
 * A Phoenix Channels **v2** message on the wire — always a five-element tuple
 * `[join_ref, ref, topic, event, payload]`:
 *
 * - `join_ref` — the reference chosen when the topic was joined; scopes a message to a channel
 *   instance. `null` on server-initiated broadcasts and on the socket-level `phoenix` topic.
 * - `ref` — a monotonic per-connection request id used to correlate a reply to its request; `null`
 *   on unsolicited broadcasts.
 * - `topic` — the Phoenix topic (Liveflux `channel`).
 * - `event` — the event name, including the protocol events `phx_join` / `phx_leave` /
 *   `phx_reply` / `phx_error` / `phx_close` and the `heartbeat` keepalive.
 * - `payload` — the event body (opaque app data, or a `{ status, response }` envelope on a reply).
 */
export type PhoenixMessage = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: unknown,
];

export interface PhoenixOptions {
  /**
   * Socket-level connect params appended to the URL query string (e.g. an auth token the Phoenix
   * `connect/3` callback reads). Carried, never invented — Liveflux passes through the app's scheme.
   *
   * Pass a **function** to have it re-invoked on every `connect()` (including reconnects), so a
   * rotated/refreshed auth token is picked up on each new socket. A plain object is read once per
   * connect, exactly as before.
   */
  params?: Record<string, string> | (() => Record<string, string>);
  /** Serializer version negotiated via the `vsn` query param. Default: `"2.0.0"` (the v2 serializer). */
  vsn?: string;
  /** Encode an outbound Phoenix message to a wire string. Default: `JSON.stringify`. */
  encode?: (message: PhoenixMessage) => string;
  /**
   * Map an inbound **data** message (not a `phx_*` control frame — those are handled internally)
   * to a `NormalizedEvent`, or return `null` to ignore it. Default: `{ channel: topic, event,
   * payload }`. Override to lift gap-recovery `cursor` / `meta` out of an enriched payload envelope,
   * since Phoenix Channels carry no native since-cursor slot.
   */
  decode?: (message: PhoenixMessage) => NormalizedEvent | null;
  /**
   * Outbound backpressure high-water mark (bytes). When the socket's `bufferedAmount` reaches this,
   * frames are queued and flushed as the buffer drains (heartbeats are dropped instead of queued).
   * Guards against buffer blow-up when a large active set is re-joined over a slow link. Default: 1 MiB.
   */
  maxBufferedAmount?: number;
  /**
   * Security guard: drop inbound string frames longer than this (measured as UTF-16 string length,
   * an approximation of bytes) before parsing — bounds memory/CPU from a malicious or buggy server.
   * Set `0` (or a non-positive value) to disable. Default: 1 MiB.
   */
  maxMessageBytes?: number;
  /**
   * Per-join reply timeout (ms). A `phx_join` with no `phx_reply` within this window is treated as
   * lost: its pending entry is cleared (no leak) and the join is retried with capped backoff.
   * Default: 10000.
   */
  joinTimeoutMs?: number;
  /**
   * Base delay (ms) before re-joining a channel after a `phx_error` or a join timeout. Doubles per
   * consecutive attempt (capped by `maxRejoinDelayMs`) so a crash-looping channel cannot hot-spin;
   * the counter resets on a successful join. Default: 50.
   */
  rejoinDelayMs?: number;
  /** Cap (ms) for the exponential re-join backoff. Default: 5000. */
  maxRejoinDelayMs?: number;
  /** WebSocket constructor. Default: `globalThis.WebSocket`. Inject for Node or tests. */
  WebSocket?: WebSocketCtor;
}

const OPEN = 1; // WebSocket.OPEN
const DEFAULT_VSN = '2.0.0';
const DEFAULT_MAX_BUFFERED = 1_048_576; // 1 MiB
const DEFAULT_MAX_MESSAGE = 1_048_576; // 1 MiB
const DEFAULT_JOIN_TIMEOUT = 10_000;
const DEFAULT_REJOIN_DELAY = 50;
const DEFAULT_MAX_REJOIN_DELAY = 5_000;
const FLUSH_POLL_MS = 16;

// Phoenix protocol events. The socket-level keepalive rides the reserved `phoenix` topic.
const JOIN = 'phx_join';
const LEAVE = 'phx_leave';
const REPLY = 'phx_reply';
const ERROR = 'phx_error';
const CLOSE = 'phx_close';
const HEARTBEAT = 'heartbeat';
const HEARTBEAT_TOPIC = 'phoenix';

/** An active subscription's Phoenix identity: its topic and the join params to replay on reconnect. */
interface Active {
  topic: string;
  params?: Record<string, unknown>;
}

/** A join awaiting its reply: which sub/topic it belongs to, and its per-join timeout handle. */
interface PendingJoin {
  subId: string;
  topic: string;
  timer: unknown;
}

/** Clamp to a positive number, else fall back to a default (guards 0 / NaN / negative inputs). */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Build the socket URL with the negotiated serializer version and any connect params. */
function connectUrl(base: string, vsn: string, params?: Record<string, string>): string {
  const query = new URLSearchParams(params);
  query.set('vsn', vsn);
  return `${base}${base.includes('?') ? '&' : '?'}${query.toString()}`;
}

/** Deserialize a wire string into a v2 message tuple, or `null` if it is not a valid one. */
function parseMessage(raw: unknown): PhoenixMessage | null {
  if (typeof raw !== 'string') return null; // the v2 serializer is JSON text; binary is out of scope
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(msg) || msg.length < 5) return null;
  const topic = msg[2];
  const event = msg[3];
  // `topic` and `event` are routing keys and must be strings; join_ref / ref are opaque tokens.
  if (typeof topic !== 'string' || typeof event !== 'string') return null;
  const joinRef = typeof msg[0] === 'string' ? msg[0] : null;
  const ref = typeof msg[1] === 'string' ? msg[1] : null;
  return [joinRef, ref, topic, event, msg[4]];
}

function defaultDecode(message: PhoenixMessage): NormalizedEvent {
  return { channel: message[2], event: message[3], payload: message[4] };
}

function isErrorReply(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { status?: unknown }).status === 'error'
  );
}

/** Recover the `subId` from a composite `join_ref` of the form `` `${subId}#${instance}` ``. */
function subIdOf(joinRef: string): string {
  const i = joinRef.lastIndexOf('#');
  return i < 0 ? joinRef : joinRef.slice(0, i);
}

/**
 * Phoenix Channels adapter for `@liveflux/core`. Speaks the hand-rolled Phoenix **v2** serializer —
 * each message is a JSON array `[join_ref, ref, topic, event, payload]` — with **zero runtime
 * dependencies** (it does not use the `phoenix` npm package).
 *
 * Mapping to the core contract: a Liveflux `channel` is a Phoenix topic; each join instance gets a
 * **fresh composite `join_ref`** `` `${subId}#${instance}` `` — recoverable to its `subId`, but
 * distinct per join so a late frame from a superseded channel instance (after a same-socket rejoin)
 * can be told apart from the live one and dropped. `ref` is a monotonic per-connection counter; both
 * `ref` and the pending-join table reset on every (re)connect, while the active subscription set (the
 * source of truth for reconnect) persists and is re-joined on each reopen — satisfying reconnect
 * recovery without the core ever calling `subscribe` again.
 *
 * Resilience: a `phx_error` transparently re-joins the crashed channel (capped exponential backoff,
 * mirroring `phoenix.js`); a `phx_join` with no reply within `joinTimeoutMs` is retried the same way;
 * and a heartbeat that is still unacked on the next `heartbeat()` tick closes the zombie socket so
 * the core reconnects. Stale lifecycle frames (a non-null `join_ref` that no longer matches the
 * current instance) are ignored.
 *
 * Scales by design: one socket multiplexes every subscription (ref-counted upstream in core), and
 * inbound routing is **O(1)** — a per-topic reference count answers "is this topic active?" without
 * scanning the subscription set. Subscribe / unsubscribe are O(1), and outbound backpressure plus the
 * memory-lean send queue are encapsulated in an internal Outbox (see `maxBufferedAmount`).
 *
 * Security: inbound is untrusted. String frames over `maxMessageBytes` are dropped before parsing
 * (DoS bound); only strict five-tuples with string `topic` / `event` are accepted, and those route
 * as Map keys, so there is no prototype-pollution path (`JSON.parse` makes `__proto__` an own,
 * non-polluting key). Payload is opaque app data; payload schema validation is the consumer's /
 * core's concern. The returned adapter is frozen and all socket state is closure-private.
 */
export function phoenix(url: string, options: PhoenixOptions = {}): StreamAdapter {
  const vsn = options.vsn ?? DEFAULT_VSN;
  const encode = options.encode ?? ((message: PhoenixMessage) => JSON.stringify(message));
  const decode = options.decode ?? defaultDecode;
  const maxBuffered = options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED;
  const rawMaxMessage = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
  const messageLimit = rawMaxMessage > 0 ? rawMaxMessage : Infinity; // <= 0 disables the cap
  const joinTimeoutMs = positive(options.joinTimeoutMs, DEFAULT_JOIN_TIMEOUT);
  const rejoinDelayMs = positive(options.rejoinDelayMs, DEFAULT_REJOIN_DELAY);
  const maxRejoinDelayMs = positive(options.maxRejoinDelayMs, DEFAULT_MAX_REJOIN_DELAY);
  // One boundary cast: the DOM WebSocket's strict event types don't match our minimal shape.
  const Ctor =
    options.WebSocket ??
    ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined);

  let socket: WebSocketLike | null = null;
  let handlers: AdapterHandlers | null = null;
  // subId → topic + join params. The source of truth replayed (re-joined) on every reopen.
  const active = new Map<string, Active>();
  // topic → number of active subs on it. Makes inbound topic routing O(1) (no scan of `active`).
  const topicCount = new Map<string, number>();
  // subId → the join_ref of its current (live) join instance. Late frames from an older instance
  // are filtered against this.
  const currentJoinRef = new Map<string, string>();
  // ref → the join awaiting this reply (with its per-join timeout). Reset on every (re)connect.
  const pendingJoins = new Map<string, PendingJoin>();
  // subId → a scheduled re-join timer (after a phx_error / join timeout). Dedupes rapid triggers.
  const rejoinTimers = new Map<string, unknown>();
  // subId → consecutive re-join attempts, driving the exponential backoff; reset on a healthy join.
  const rejoinAttempts = new Map<string, number>();
  let refCounter = 0;
  let joinInstance = 0; // mints a fresh join_ref per join; restarts each connection (new socket)
  let heartbeatRef: string | null = null; // outstanding heartbeat ref, or null if acked / none sent

  const nextRef = (): string => String(++refCounter);
  const isOpen = (): boolean => socket !== null && socket.readyState === OPEN;
  const hasActiveTopic = (topic: string): boolean => topicCount.has(topic);

  const safeSend = (s: WebSocketLike, data: string): void => {
    try {
      s.send(data);
    } catch {
      /* benign send race on a closing socket — active subs are re-joined on the next open */
    }
  };

  // The socket, viewed as an abstract writable sink for the Outbox (queueing stays decoupled from
  // WebSocket specifics).
  const sink: Sink = {
    state() {
      const s = socket;
      if (!s || s.readyState !== OPEN) return 'closed';
      return (s.bufferedAmount ?? 0) >= maxBuffered ? 'congested' : 'ready';
    },
    write(data) {
      if (socket) safeSend(socket, data);
    },
  };
  const outbox = new Outbox(sink, FLUSH_POLL_MS);

  // Send a `phx_join` for one active sub: mint a fresh composite join_ref (recorded as the sub's
  // current instance), record the pending reply with a per-join timeout, and enqueue the frame.
  // Called on subscribe (when open), on reopen, and on a backed-off re-join.
  const sendJoin = (subId: string): void => {
    const entry = active.get(subId);
    if (!entry) return;
    const joinRef = `${subId}#${++joinInstance}`;
    currentJoinRef.set(subId, joinRef);
    const ref = nextRef();
    const timer = arm(joinTimeoutMs, () => {
      if (!pendingJoins.has(ref)) return; // already answered
      pendingJoins.delete(ref); // plug the bounded leak
      scheduleRejoin(subId); // retry the join with capped backoff
    });
    pendingJoins.set(ref, { subId, topic: entry.topic, timer });
    outbox.push(encode([joinRef, ref, entry.topic, JOIN, entry.params ?? {}]));
  };

  // Re-join a sub after a channel error or a join timeout, spaced by exponential backoff (capped) so
  // a crash-looping channel cannot hot-spin. Deduped per sub; the attempt counter resets on success.
  const scheduleRejoin = (subId: string): void => {
    if (rejoinTimers.has(subId) || !active.has(subId)) return;
    const step = rejoinAttempts.get(subId) ?? 0;
    rejoinAttempts.set(subId, step + 1);
    const delay = Math.min(rejoinDelayMs * 2 ** step, maxRejoinDelayMs);
    const timer = arm(delay, () => {
      rejoinTimers.delete(subId);
      if (isOpen()) sendJoin(subId); // otherwise the next onOpen replays the whole active set
    });
    rejoinTimers.set(subId, timer);
  };

  // Drop all per-connection timers/state. Called on (re)connect and teardown; the active set (the
  // reconnect source of truth) is left intact.
  const clearTransient = (): void => {
    for (const p of pendingJoins.values()) timers.clearTimeout(p.timer);
    pendingJoins.clear();
    for (const t of rejoinTimers.values()) timers.clearTimeout(t);
    rejoinTimers.clear();
    rejoinAttempts.clear();
    currentJoinRef.clear();
    heartbeatRef = null;
  };

  const retire = (s: WebSocketLike): void => {
    s.onopen = s.onclose = s.onerror = s.onmessage = null; // detach: no callbacks after this
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };

  const onMessage = (raw: unknown): void => {
    const h = handlers;
    if (!h) return;
    // Transport-level DoS guard: drop oversized string frames before parsing.
    if (typeof raw === 'string' && raw.length > messageLimit) return;
    const message = parseMessage(raw);
    if (!message) return;
    const [joinRef, ref, topic, event] = message;

    if (event === REPLY) {
      // Socket-level heartbeat ack: clears the outstanding heartbeat so the next tick is not read as
      // a dead link. Carries a null join_ref, so it never reaches the join-correlation path below.
      if (topic === HEARTBEAT_TOPIC) {
        if (ref !== null && ref === heartbeatRef) heartbeatRef = null;
        return;
      }
      // Correlate a reply to its pending join by ref; a rejected join is surfaced, an ok join resets
      // the topic's re-join backoff, any other reply is silently consumed.
      if (ref === null) return;
      const pending = pendingJoins.get(ref);
      if (pending === undefined) return;
      timers.clearTimeout(pending.timer);
      pendingJoins.delete(ref);
      // Stale-instance filter: a newer join for this sub has superseded this in-flight one → ignore
      // its late reply so it neither fires an error nor resets the live instance's backoff.
      if (joinRef !== null && currentJoinRef.get(pending.subId) !== joinRef) return;
      if (isErrorReply(message[4])) {
        handlers?.onError({ type: 'join_error', channel: pending.topic, reply: message[4] });
      } else {
        rejoinAttempts.delete(pending.subId);
      }
      return;
    }

    if (event === ERROR) {
      // Ignore a phx_error from a superseded join instance (its join_ref is no longer current).
      if (joinRef !== null && currentJoinRef.get(subIdOf(joinRef)) !== joinRef) return;
      if (!hasActiveTopic(topic)) return;
      // Surface for observability, then transparently re-join every active sub on the crashed topic
      // (with backoff), mirroring the real phoenix.js client — the sub is not left permanently dead.
      h.onError({ type: 'channel_error', channel: topic });
      for (const [subId, e] of active) if (e.topic === topic) scheduleRejoin(subId);
      return;
    }

    if (event === CLOSE) return; // graceful close after a leave (or a superseded instance) — no action

    // A data event (join_ref is null on broadcasts): deliver once per active topic (core fans out to
    // every listener on that channel).
    if (!hasActiveTopic(topic)) return;
    const normalized = decode(message);
    if (normalized) h.onEvent(normalized);
  };

  return Object.freeze<StreamAdapter>({
    connect(nextHandlers: AdapterHandlers): void {
      if (!Ctor) {
        throw new Error(
          '@liveflux/phoenix: no WebSocket implementation found — pass options.WebSocket.',
        );
      }
      // Fully retire any prior socket so a reconnect never leaves a dangling connection behind.
      if (socket) retire(socket);
      outbox.reset(); // drop stale pending; `active` is the source of truth on (re)connect
      clearTransient();
      refCounter = 0; // refs are per-connection; the fresh socket starts its own sequence
      joinInstance = 0; // join instances restart per socket — no cross-socket join_ref collisions
      handlers = nextHandlers;
      // Re-read connect params on every connect so a params *function* re-auths each new socket.
      const params = typeof options.params === 'function' ? options.params() : options.params;
      const s = new Ctor(connectUrl(url, vsn, params));
      socket = s;
      s.onopen = () => {
        for (const subId of active.keys()) sendJoin(subId); // re-join the active set on every open
        nextHandlers.onOpen();
      };
      s.onclose = (ev) => nextHandlers.onClose(ev);
      s.onerror = (ev) => nextHandlers.onError(ev);
      s.onmessage = (ev) => onMessage(ev.data);
    },

    disconnect(): void {
      const s = socket;
      socket = null;
      handlers = null;
      outbox.reset();
      clearTransient();
      if (s) retire(s);
    },

    subscribe(sub: SubscribeRequest): void {
      active.set(sub.subId, {
        topic: sub.channel,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
      });
      topicCount.set(sub.channel, (topicCount.get(sub.channel) ?? 0) + 1);
      // Join now if the link is up; otherwise the next onOpen replays the whole active set (so a
      // subscribe issued before open is never lost and never double-sent).
      if (isOpen()) sendJoin(sub.subId);
    },

    unsubscribe(subId: string): void {
      const entry = active.get(subId);
      if (!entry) return;
      active.delete(subId); // dropped from the active set → not re-joined on reconnect
      const joinRef = currentJoinRef.get(subId) ?? subId;
      currentJoinRef.delete(subId);
      const rejoin = rejoinTimers.get(subId);
      if (rejoin !== undefined) {
        timers.clearTimeout(rejoin);
        rejoinTimers.delete(subId);
      }
      rejoinAttempts.delete(subId);
      const remaining = (topicCount.get(entry.topic) ?? 1) - 1;
      if (remaining > 0) topicCount.set(entry.topic, remaining);
      else topicCount.delete(entry.topic);
      if (isOpen()) outbox.push(encode([joinRef, nextRef(), entry.topic, LEAVE, {}]));
    },

    heartbeat(): void {
      // Dead-link detection: the previous heartbeat is still unacked on this tick → zombie socket.
      // Close it (fires onClose → the core reconnects) and reset heartbeat state.
      if (heartbeatRef !== null) {
        heartbeatRef = null;
        const s = socket;
        if (s) {
          try {
            s.close();
          } catch {
            /* already closing */
          }
        }
        return;
      }
      // Redundant under load — send only when the link can take it immediately; never queue it.
      if (sink.state() !== 'ready') return;
      const ref = nextRef();
      heartbeatRef = ref;
      sink.write(encode([null, ref, HEARTBEAT_TOPIC, HEARTBEAT, {}]));
    },
  });
}
