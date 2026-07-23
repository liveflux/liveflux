import type {
  AdapterHandlers,
  NormalizedEvent,
  StreamAdapter,
  SubscribeRequest,
} from '@liveflux/core';

/** A minimal WebSocket-like object (browser WebSocket, Node `ws`, or a test double). */
interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** A GraphQL subscription operation derived from a liveflux channel + params. */
export interface GraphqlOperation {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GraphqlWsOptions {
  /** WebSocket constructor. Default: `globalThis.WebSocket`. Inject for Node or tests. */
  WebSocket?: WebSocketCtor;
  /**
   * Map a liveflux channel (+ params) to a GraphQL subscription operation. Default: the channel IS
   * the subscription document and params ARE the variables — override to name operations, wrap
   * documents, etc.
   */
  query?: (channel: string, params?: Record<string, unknown>) => GraphqlOperation;
  /** Payload sent with `connection_init` (e.g. an auth token). A function is re-resolved per (re)connect. */
  connectionParams?:
    | Record<string, unknown>
    | (() => Record<string, unknown> | undefined);
  /**
   * Decode a `next` message's payload (a GraphQL `ExecutionResult`) into a NormalizedEvent, or `null`
   * to ignore it. Receives the result and the channel the subscription is bound to. Default:
   * `{ channel, event: 'next', payload: result.data ?? result }`.
   */
  decode?: (payload: unknown, channel: string) => NormalizedEvent | null;
  /**
   * Security guard: drop inbound string frames longer than this (approx. bytes) before parsing. Set
   * `0` to disable. Default: 1 MiB.
   */
  maxMessageBytes?: number;
}

const PROTOCOL = 'graphql-transport-ws';
const OPEN = 1; // WebSocket.OPEN
const DEFAULT_MAX_MESSAGE = 1_048_576; // 1 MiB

function defaultQuery(channel: string, params?: Record<string, unknown>): GraphqlOperation {
  return { query: channel, ...(params !== undefined ? { variables: params } : {}) };
}

function defaultDecode(payload: unknown, channel: string): NormalizedEvent | null {
  const data =
    payload && typeof payload === 'object' && 'data' in payload
      ? (payload as { data: unknown }).data
      : payload;
  return { channel, event: 'next', payload: data };
}

/**
 * `graphql-transport-ws` adapter for `@liveflux/core`. Speaks the protocol directly over a WebSocket
 * (zero dependencies — it does NOT wrap a GraphQL client): `connection_init` → `connection_ack`
 * handshake, then one `subscribe` operation per channel keyed by the subscription id, with server
 * `next` / `error` / `complete` and `ping` → `pong` keepalive.
 *
 * A liveflux channel maps to a GraphQL subscription document (override with `query`); each `next`
 * result is routed back to its channel by subscription id and normalised via `decode`. Reconnect-safe:
 * the core drives reconnect, and the active subscription set is replayed after each `connection_ack`.
 *
 * Security: inbound is untrusted — frames over `maxMessageBytes` are dropped before parsing, and only
 * well-formed typed messages are acted on. The returned adapter is frozen and all socket state is
 * closure-private. Pass `url` as a function (and/or `connectionParams` as a function) to re-resolve a
 * rotated token on every (re)connect.
 */
export function graphqlWs(url: string | (() => string), options: GraphqlWsOptions = {}): StreamAdapter {
  const query = options.query ?? defaultQuery;
  const decode = options.decode ?? defaultDecode;
  const rawMax = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
  const messageLimit = rawMax > 0 ? rawMax : Infinity;
  const Ctor =
    options.WebSocket ??
    ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined);

  let socket: WebSocketLike | null = null;
  let acked = false;
  const isReady = (): boolean => socket !== null && socket.readyState === OPEN && acked;
  // subId → { channel, payload } — the subscribe operation, replayed verbatim after each ack.
  const active = new Map<string, { channel: string; payload: GraphqlOperation }>();

  const resolveUrl = (): string => (typeof url === 'function' ? url() : url);

  const rawSend = (msg: unknown): void => {
    const s = socket;
    if (s && s.readyState === OPEN) {
      try {
        s.send(JSON.stringify(msg));
      } catch {
        /* benign send race on a closing socket — active subs are replayed after the next ack */
      }
    }
  };
  const sendSubscribe = (subId: string, payload: GraphqlOperation): void =>
    rawSend({ id: subId, type: 'subscribe', payload });

  const retire = (s: WebSocketLike): void => {
    s.onopen = s.onclose = s.onerror = s.onmessage = null;
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };

  return Object.freeze<StreamAdapter>({
    connect(handlers: AdapterHandlers): void {
      if (!Ctor) {
        throw new Error('@liveflux/graphql-ws: no WebSocket implementation found — pass options.WebSocket.');
      }
      if (socket) retire(socket);
      acked = false;
      const s = new Ctor(resolveUrl(), PROTOCOL);
      socket = s;

      s.onopen = () => {
        const cp = typeof options.connectionParams === 'function' ? options.connectionParams() : options.connectionParams;
        rawSend({ type: 'connection_init', ...(cp !== undefined ? { payload: cp } : {}) });
        // NOTE: onOpen is deferred until connection_ack (the server must accept the connection first).
      };
      s.onmessage = (ev) => {
        const raw = ev.data;
        if (typeof raw === 'string' && raw.length > messageLimit) return;
        let msg: { type?: unknown; id?: unknown; payload?: unknown };
        try {
          msg = JSON.parse(raw as string);
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;
        switch (msg.type) {
          case 'connection_ack': {
            acked = true;
            for (const [subId, entry] of active) sendSubscribe(subId, entry.payload); // replay
            handlers.onOpen();
            break;
          }
          case 'ping': {
            rawSend({ type: 'pong', ...(msg.payload !== undefined ? { payload: msg.payload } : {}) });
            break;
          }
          case 'next': {
            if (typeof msg.id !== 'string') break;
            const entry = active.get(msg.id);
            if (!entry) break; // unknown / already-completed subscription
            const event = decode(msg.payload, entry.channel);
            if (event) handlers.onEvent(event);
            break;
          }
          case 'error': {
            handlers.onError(msg.payload); // subscription-level GraphQL error
            break;
          }
          case 'complete': {
            if (typeof msg.id === 'string') active.delete(msg.id); // server ended this subscription
            break;
          }
        }
      };
      s.onclose = (ev) => {
        acked = false;
        handlers.onClose(ev);
      };
      s.onerror = (ev) => handlers.onError(ev);
    },

    disconnect(): void {
      const s = socket;
      socket = null;
      acked = false;
      if (s) retire(s);
    },

    subscribe(sub: SubscribeRequest): void {
      const op = query(sub.channel, sub.params);
      const payload: GraphqlOperation = {
        query: op.query,
        ...(op.variables !== undefined ? { variables: op.variables } : {}),
        ...(op.operationName !== undefined ? { operationName: op.operationName } : {}),
      };
      active.set(sub.subId, { channel: sub.channel, payload });
      if (isReady()) sendSubscribe(sub.subId, payload);
    },

    unsubscribe(subId: string): void {
      if (!active.has(subId)) return; // idempotent: unknown / already-removed → no frame
      active.delete(subId);
      if (isReady()) rawSend({ id: subId, type: 'complete' });
    },
  });
}
