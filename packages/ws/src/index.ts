import type {
  AdapterHandlers,
  NormalizedEvent,
  StreamAdapter,
  SubscribeRequest,
} from '@liveflux/core';
import { Outbox, type Sink } from './internal/outbox';

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

/** Outbound control frames of the default protocol. */
export type OutboundFrame =
  | { type: 'subscribe'; subId: string; channel: string; params?: Record<string, unknown> }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'heartbeat' };

export interface WsOptions {
  /**
   * WebSocket sub-protocol(s). Pass a function to resolve them lazily on every (re)connect — the
   * same rotation story as a function `url` (e.g. a protocol-carried bearer token).
   */
  protocols?: string | string[] | (() => string | string[] | undefined);
  /** Encode an outbound control frame to a wire string. Default: `JSON.stringify`. */
  encode?: (frame: OutboundFrame) => string;
  /**
   * Decode an inbound message into a NormalizedEvent, or return `null` to ignore it (acks,
   * heartbeats, non-event frames). Default: JSON-parse expecting `{ channel, event, payload }`.
   */
  decode?: (raw: unknown) => NormalizedEvent | null;
  /**
   * Outbound backpressure high-water mark (bytes). When the socket's `bufferedAmount` reaches this,
   * control frames are queued and flushed as the buffer drains (heartbeats are dropped instead of
   * queued). Guards against buffer blow-up when a large active set is replayed over a slow link.
   * Default: 1 MiB.
   */
  maxBufferedAmount?: number;
  /**
   * Security guard: drop inbound string frames longer than this (approx. bytes, measured as string
   * length) before decoding — bounds memory/CPU from a malicious or buggy server. Set `0` (or a
   * non-positive value) to disable. Default: 1 MiB.
   */
  maxMessageBytes?: number;
  /** WebSocket constructor. Default: `globalThis.WebSocket`. Inject for Node or tests. */
  WebSocket?: WebSocketCtor;
}

const OPEN = 1; // WebSocket.OPEN
const DEFAULT_MAX_BUFFERED = 1_048_576; // 1 MiB
const DEFAULT_MAX_MESSAGE = 1_048_576; // 1 MiB
const FLUSH_POLL_MS = 16;

function defaultDecode(raw: unknown): NormalizedEvent | null {
  if (typeof raw !== 'string') return null; // binary frames are the caller's job (custom decode)
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { channel?: unknown }).channel === 'string' &&
    typeof (msg as { event?: unknown }).event === 'string'
  ) {
    return msg as NormalizedEvent;
  }
  return null;
}

/**
 * Generic WebSocket adapter for `@liveflux/core`. Works with ANY backend that exposes a plain
 * WebSocket, in any language — it speaks a small JSON control protocol (subscribe / unsubscribe /
 * heartbeat outbound; `{ channel, event, payload }` events inbound), both sides overridable via
 * `encode` / `decode`.
 *
 * Scales by design: one socket multiplexes every subscription (ref-counted upstream in core),
 * subscribe/unsubscribe are O(1), and each subscribe frame is encoded exactly once (the wire string
 * is cached and replayed verbatim on reconnect — no repeated `JSON.stringify`). Reconnect-safe:
 * active subscriptions are re-sent on every (re)open. Outbound backpressure and the memory-lean send
 * queue are encapsulated in an internal Outbox (see `maxBufferedAmount`).
 *
 * Security: inbound is untrusted. String frames over `maxMessageBytes` are dropped before decoding
 * (DoS bound), and the default decoder accepts only `{ channel, event, ... }` objects with string
 * `channel`/`event` — which core routes as Map keys, so no prototype-pollution path (`JSON.parse`
 * makes `__proto__` an own, non-polluting key). Payload is opaque app data; payload schema
 * validation is the consumer's / core's concern. The returned adapter is frozen and all socket
 * state is closure-private.
 *
 * Reconnect auth: pass `url` (and/or `protocols`) as a function to re-resolve it on every
 * (re)connect — a rotated short-lived token in the query string or a sub-protocol is picked up on
 * the reconnect that follows an auth-expiry close, with no adapter rebuild.
 */
export function ws(url: string | (() => string), options: WsOptions = {}): StreamAdapter {
  const encode = options.encode ?? JSON.stringify;
  const decode = options.decode ?? defaultDecode;
  const maxBuffered = options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED;
  const rawMaxMessage = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
  const messageLimit = rawMaxMessage > 0 ? rawMaxMessage : Infinity; // <= 0 disables the cap
  // One boundary cast: the DOM WebSocket's strict event types don't match our minimal shape.
  const Ctor =
    options.WebSocket ??
    ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined);

  let socket: WebSocketLike | null = null;
  const isOpen = (): boolean => socket !== null && socket.readyState === OPEN;
  // subId → the pre-encoded subscribe frame. A subscribe frame is immutable once created, so it is
  // encoded exactly once and the wire string is reused verbatim on every reconnect.
  const active = new Map<string, string>();

  const safeSend = (s: WebSocketLike, data: string): void => {
    try {
      s.send(data);
    } catch {
      /* benign send race on a closing socket — core re-sends active subs on the next open */
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

  const retire = (s: WebSocketLike): void => {
    s.onopen = s.onclose = s.onerror = s.onmessage = null; // detach: no callbacks after this
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };

  return Object.freeze<StreamAdapter>({
    connect(handlers: AdapterHandlers): void {
      if (!Ctor) {
        throw new Error(
          '@liveflux/ws: no WebSocket implementation found — pass options.WebSocket.',
        );
      }
      // Fully retire any prior socket so a reconnect never leaves a dangling connection behind.
      if (socket) retire(socket);
      outbox.reset(); // drop stale pending; `active` is the source of truth on (re)connect
      // Resolve url / protocols per (re)connect so a rotated token re-auths on reconnect.
      const resolvedUrl = typeof url === 'function' ? url() : url;
      const resolvedProtocols =
        typeof options.protocols === 'function' ? options.protocols() : options.protocols;
      const s = new Ctor(resolvedUrl, resolvedProtocols);
      socket = s;
      s.onopen = () => {
        for (const data of active.values()) outbox.push(data); // replay cached subs (backpressured)
        handlers.onOpen();
      };
      s.onclose = (ev) => handlers.onClose(ev);
      s.onerror = (ev) => handlers.onError(ev);
      s.onmessage = (ev) => {
        const raw = ev.data;
        // Transport-level DoS guard: drop oversized string frames before decoding (applies even to
        // a custom decoder). Binary frames carry no `.length` and fall through to the decoder.
        if (typeof raw === 'string' && raw.length > messageLimit) return;
        const event = decode(raw);
        if (event) handlers.onEvent(event);
      };
    },

    disconnect(): void {
      const s = socket;
      socket = null;
      outbox.reset();
      if (s) retire(s);
    },

    subscribe(sub: SubscribeRequest): void {
      const frame: Extract<OutboundFrame, { type: 'subscribe' }> = {
        type: 'subscribe',
        subId: sub.subId,
        channel: sub.channel,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
      };
      const data = encode(frame);
      active.set(sub.subId, data); // cache the wire string once; reused on every reconnect
      // Send now only if the link is up; otherwise the next onOpen replays the whole active set (so
      // a subscribe issued before open is never lost and never double-sent).
      if (isOpen()) outbox.push(data);
    },

    unsubscribe(subId: string): void {
      if (!active.has(subId)) return; // idempotent: unknown / already-removed → no wire frame
      active.delete(subId);
      if (isOpen()) outbox.push(encode({ type: 'unsubscribe', subId }));
    },

    heartbeat(): void {
      // Redundant under load — send only when the link can take it immediately; never queue it.
      if (sink.state() === 'ready') sink.write(encode({ type: 'heartbeat' }));
    },
  });
}
