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
   */
  params?: Record<string, string>;
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
   * Security guard: drop inbound string frames longer than this (approx. bytes, measured as string
   * length) before parsing — bounds memory/CPU from a malicious or buggy server. Set `0` (or a
   * non-positive value) to disable. Default: 1 MiB.
   */
  maxMessageBytes?: number;
  /** WebSocket constructor. Default: `globalThis.WebSocket`. Inject for Node or tests. */
  WebSocket?: WebSocketCtor;
}

const OPEN = 1; // WebSocket.OPEN
const DEFAULT_VSN = '2.0.0';
const DEFAULT_MAX_BUFFERED = 1_048_576; // 1 MiB
const DEFAULT_MAX_MESSAGE = 1_048_576; // 1 MiB
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

/**
 * Phoenix Channels adapter for `@liveflux/core`. Speaks the hand-rolled Phoenix **v2** serializer —
 * each message is a JSON array `[join_ref, ref, topic, event, payload]` — with **zero runtime
 * dependencies** (it does not use the `phoenix` npm package).
 *
 * Mapping to the core contract: a Liveflux `channel` is a Phoenix topic; a `subId` is used verbatim
 * as that topic's `join_ref` — a stable, opaque per-subscription join token that makes replies
 * self-correlating and needs no side table. `ref` is a monotonic per-connection counter; both `ref`
 * and the pending-join table reset on every (re)connect, while the active subscription set (the
 * source of truth for reconnect) persists and is re-joined on each reopen — satisfying reconnect
 * recovery without the core ever calling `subscribe` again.
 *
 * Scales by design: one socket multiplexes every subscription (ref-counted upstream in core),
 * subscribe / unsubscribe are O(1), and outbound backpressure plus the memory-lean send queue are
 * encapsulated in an internal Outbox (see `maxBufferedAmount`).
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
  // One boundary cast: the DOM WebSocket's strict event types don't match our minimal shape.
  const Ctor =
    options.WebSocket ??
    ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined);
  const target = connectUrl(url, vsn, options.params);

  let socket: WebSocketLike | null = null;
  // subId → topic + join params. The source of truth replayed (re-joined) on every reopen.
  const active = new Map<string, Active>();
  // Per-connection request/reply correlation for joins, so a rejected join surfaces via onError.
  const pendingJoins = new Map<string, string>(); // ref → topic
  let refCounter = 0;

  const nextRef = (): string => String(++refCounter);
  const isOpen = (): boolean => socket !== null && socket.readyState === OPEN;
  const hasActiveTopic = (topic: string): boolean => {
    for (const entry of active.values()) if (entry.topic === topic) return true;
    return false;
  };

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

  // Send a `phx_join` for one active sub, using its subId as the topic's join_ref and a fresh ref
  // recorded so the matching reply can be correlated. Called on subscribe (when open) and on reopen.
  const sendJoin = (subId: string): void => {
    const entry = active.get(subId);
    if (!entry) return;
    const ref = nextRef();
    pendingJoins.set(ref, entry.topic);
    outbox.push(encode([subId, ref, entry.topic, JOIN, entry.params ?? {}]));
  };

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
          '@liveflux/phoenix: no WebSocket implementation found — pass options.WebSocket.',
        );
      }
      // Fully retire any prior socket so a reconnect never leaves a dangling connection behind.
      if (socket) retire(socket);
      outbox.reset(); // drop stale pending; `active` is the source of truth on (re)connect
      pendingJoins.clear();
      refCounter = 0; // refs are per-connection; the fresh socket starts its own sequence
      const s = new Ctor(target);
      socket = s;
      s.onopen = () => {
        for (const subId of active.keys()) sendJoin(subId); // re-join the active set on every open
        handlers.onOpen();
      };
      s.onclose = (ev) => handlers.onClose(ev);
      s.onerror = (ev) => handlers.onError(ev);
      s.onmessage = (ev) => {
        const raw = ev.data;
        // Transport-level DoS guard: drop oversized string frames before parsing.
        if (typeof raw === 'string' && raw.length > messageLimit) return;
        const message = parseMessage(raw);
        if (!message) return;
        const [, ref, topic, event] = message;

        if (event === REPLY) {
          // Correlate a reply to its pending join; a rejected join is surfaced, an ok join / any
          // other reply (leaves, heartbeats) is silently consumed.
          if (ref === null) return;
          const joinTopic = pendingJoins.get(ref);
          if (joinTopic === undefined) return;
          pendingJoins.delete(ref);
          if (isErrorReply(message[4])) {
            handlers.onError({ type: 'join_error', channel: joinTopic, reply: message[4] });
          }
          return;
        }
        if (event === ERROR) {
          // The channel crashed server-side. Surface it (core owns connection-level reconnect);
          // channel-level rejoin with backoff is a deliberate future increment.
          if (hasActiveTopic(topic)) handlers.onError({ type: 'channel_error', channel: topic });
          return;
        }
        if (event === CLOSE) return; // graceful close after a leave — nothing to do

        // A data event: deliver once per topic (core fans out to every listener on that channel).
        if (!hasActiveTopic(topic)) return;
        const normalized = decode(message);
        if (normalized) handlers.onEvent(normalized);
      };
    },

    disconnect(): void {
      const s = socket;
      socket = null;
      outbox.reset();
      pendingJoins.clear();
      if (s) retire(s);
    },

    subscribe(sub: SubscribeRequest): void {
      active.set(sub.subId, {
        topic: sub.channel,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
      });
      // Join now if the link is up; otherwise the next onOpen replays the whole active set (so a
      // subscribe issued before open is never lost and never double-sent).
      if (isOpen()) sendJoin(sub.subId);
    },

    unsubscribe(subId: string): void {
      const entry = active.get(subId);
      active.delete(subId); // dropped from the active set → not re-joined on reconnect
      if (entry && isOpen()) outbox.push(encode([subId, nextRef(), entry.topic, LEAVE, {}]));
    },

    heartbeat(): void {
      // Redundant under load — send only when the link can take it immediately; never queue it.
      if (sink.state() === 'ready')
        sink.write(encode([null, nextRef(), HEARTBEAT_TOPIC, HEARTBEAT, {}]));
    },
  });
}
