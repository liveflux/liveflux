import type {
  AdapterHandlers,
  Cursor,
  NormalizedEvent,
  PublishRequest,
  ReplyFrame,
  RequestFrame,
  StreamAdapter,
  SubscribeRequest,
} from '@liveflux/core';

/**
 * The minimal slice of a Socket.IO client `Socket` this adapter uses. The real `socket.io-client`
 * `Socket` satisfies it structurally, so you pass your own socket and we never import (or bundle)
 * the library — it stays an optional peer.
 */
export interface SocketLike {
  readonly connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  connect(): unknown;
  disconnect(): unknown;
}

export interface SocketioOptions {
  /** Server→client event carrying stream events. Default: `'message'`. */
  eventName?: string;
  /** Client→server event names for the control frames. Defaults: `subscribe` / `unsubscribe` / `resume`. */
  subscribeEvent?: string;
  unsubscribeEvent?: string;
  resumeEvent?: string;
  /**
   * Client→server event names for the command frames. Defaults: `publish` (fire-and-forget) and
   * `request` (RPC — sent with a Socket.IO ack callback so the reply rides the native ack, no
   * requestId echo needed on the wire).
   */
  publishEvent?: string;
  requestEvent?: string;
  /**
   * Decode an inbound payload (already JSON-parsed by Socket.IO) into a NormalizedEvent, or `null`
   * to ignore it. Default: accept `{ channel, event, payload, cursor?, meta? }` objects.
   */
  decode?: (payload: unknown) => NormalizedEvent | null;
}

function defaultDecode(payload: unknown): NormalizedEvent | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { channel?: unknown }).channel === 'string' &&
    typeof (payload as { event?: unknown }).event === 'string'
  ) {
    return payload as NormalizedEvent;
  }
  return null;
}

type SubscribeFrame = { subId: string; channel: string; params?: Record<string, unknown> };

/** A command frame (publish / request) emitted to the server, carrying meta/idempotencyKey when set. */
type CommandFrame = {
  channel: string;
  event: string;
  payload: unknown;
  meta?: Record<string, unknown>;
  idempotencyKey?: string;
};

function commandFrame(req: PublishRequest | RequestFrame): CommandFrame {
  return {
    channel: req.channel,
    event: req.event,
    payload: req.payload,
    ...(req.meta !== undefined ? { meta: req.meta } : {}),
    ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
  };
}

/**
 * Map a Socket.IO ack value to a core `ReplyFrame`, correlated by the requestId we hold in the ack
 * closure (Socket.IO matches the ack to its emit — no requestId travels on the wire). A `{ ok, … }`
 * envelope is honoured verbatim; any other bare value is treated as a successful reply carrying it.
 */
function ackToReply(requestId: string, response: unknown): ReplyFrame {
  if (response !== null && typeof response === 'object' && typeof (response as { ok?: unknown }).ok === 'boolean') {
    const r = response as { ok: boolean; payload?: unknown; error?: ReplyFrame['error'] };
    return {
      requestId,
      ok: r.ok,
      ...('payload' in r ? { payload: r.payload } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
    };
  }
  return { requestId, ok: true, payload: response };
}

/**
 * Socket.IO adapter for `@liveflux/core`. Wraps a Socket.IO client `Socket` you already created, so
 * its transport upgrade, rooms, and auth stay yours — this only maps the connection lifecycle and a
 * stream event onto the core's normalized contract.
 *
 * Lifecycle: `connect` → replay the active subscription set + `onOpen`; `disconnect(reason)` →
 * `onClose(reason)`; `connect_error(err)` → `onError(err)`; each `eventName` message → `onEvent`.
 * Reconnect-safe: the active set is re-emitted on every (re)connect. Because the core drives reconnect
 * (it re-`connect`s on close), create the socket with `reconnection: false` so there is exactly one
 * backoff policy — the core's — and no double retry.
 *
 * Security: inbound payloads are untrusted; the default decoder accepts only `{ channel, event, … }`
 * objects with string `channel`/`event` (routed as core Map keys — no prototype-pollution path).
 * Zero bundled dependencies — `socket.io-client` is an optional peer you provide. The returned
 * adapter is frozen and its listeners are closure-private.
 */
export function socketio(socket: SocketLike, options: SocketioOptions = {}): StreamAdapter {
  const eventName = options.eventName ?? 'message';
  const subscribeEvent = options.subscribeEvent ?? 'subscribe';
  const unsubscribeEvent = options.unsubscribeEvent ?? 'unsubscribe';
  const resumeEvent = options.resumeEvent ?? 'resume';
  const publishEvent = options.publishEvent ?? 'publish';
  const requestEvent = options.requestEvent ?? 'request';
  const decode = options.decode ?? defaultDecode;

  // subId → subscribe frame; immutable once created, replayed verbatim on every (re)connect.
  const active = new Map<string, SubscribeFrame>();
  // The handlers of the live connection — needed by `request` to route a reply into onReply.
  let boundHandlers: AdapterHandlers | null = null;
  // The currently-attached listeners, so a re-connect detaches cleanly (no leak / double-fire).
  let bound: {
    connect: () => void;
    disconnect: (...args: unknown[]) => void;
    connectError: (...args: unknown[]) => void;
    data: (...args: unknown[]) => void;
  } | null = null;

  const detach = (): void => {
    if (!bound) return;
    socket.off('connect', bound.connect);
    socket.off('disconnect', bound.disconnect);
    socket.off('connect_error', bound.connectError);
    socket.off(eventName, bound.data);
    bound = null;
  };

  return Object.freeze<StreamAdapter>({
    connect(handlers: AdapterHandlers): void {
      detach(); // idempotent across the core's reconnects — never stack listeners
      boundHandlers = handlers;

      const onConnect = (): void => {
        for (const frame of active.values()) socket.emit(subscribeEvent, frame); // replay
        handlers.onOpen();
      };
      const onDisconnect = (...args: unknown[]): void => handlers.onClose(args[0]);
      const onConnectError = (...args: unknown[]): void => handlers.onError(args[0]);
      const onData = (...args: unknown[]): void => {
        const event = decode(args[0]);
        if (event) handlers.onEvent(event);
      };

      bound = { connect: onConnect, disconnect: onDisconnect, connectError: onConnectError, data: onData };
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
      socket.on('connect_error', onConnectError);
      socket.on(eventName, onData);

      // Already connected (e.g. the socket the consumer handed us is live) → open immediately;
      // otherwise start connecting and let the `connect` handler fire onOpen.
      if (socket.connected) onConnect();
      else socket.connect();
    },

    disconnect(): void {
      detach(); // detach BEFORE closing so the client-initiated disconnect doesn't fire onClose
      boundHandlers = null;
      socket.disconnect();
    },

    subscribe(sub: SubscribeRequest): void {
      const frame: SubscribeFrame = {
        subId: sub.subId,
        channel: sub.channel,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
      };
      active.set(sub.subId, frame);
      if (socket.connected) socket.emit(subscribeEvent, frame);
    },

    unsubscribe(subId: string): void {
      if (!active.has(subId)) return; // idempotent: unknown / already-removed → no frame
      active.delete(subId);
      if (socket.connected) socket.emit(unsubscribeEvent, { subId });
    },

    resume(subId: string, cursor: Cursor | null): void {
      socket.emit(resumeEvent, { subId, cursor });
    },

    publish(req: PublishRequest): void {
      // Fire-and-forget: no ack callback. The core only calls this while the connection is open.
      socket.emit(publishEvent, commandFrame(req));
    },

    request(req: RequestFrame): void {
      // RPC over Socket.IO's native ack: the server's ack callback IS the reply, correlated by
      // Socket.IO itself. The `requestId` still rides on the frame (so the server can log / dedupe),
      // but the reply is matched by the ack closure, not by the id. The core owns the requestId,
      // timeout, and cancellation; a reply after teardown is dropped (handlers detached).
      socket.emit(requestEvent, { requestId: req.requestId, ...commandFrame(req) }, (response: unknown) => {
        boundHandlers?.onReply?.(ackToReply(req.requestId, response));
      });
    },
  });
}
