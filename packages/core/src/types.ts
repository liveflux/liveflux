/**
 * @liveflux/core — shared public types.
 * The transport-neutral contracts every module and adapter speaks.
 */

/** Identifier for an entity in an `upsert` stream. */
export type Id = string | number;

/** Opaque since-token for gap recovery. Only the adapter interprets it. */
export type Cursor = string;

/** Lifecycle of the underlying connection. */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** A decoded, transport-neutral event handed to the core by an adapter. */
export interface NormalizedEvent {
  channel: string;
  event: string;
  payload: unknown;
  cursor?: Cursor;
  meta?: Record<string, unknown>;
}

/** A server→client reply to a client-initiated {@link RequestFrame}, correlated by `requestId`. */
export interface ReplyFrame {
  requestId: string;
  /** `true` → resolve with `payload`; `false` → reject with `error`. */
  ok: boolean;
  /** Present on a successful reply. */
  payload?: unknown;
  /** Present on a rejected reply — a server-application error. */
  error?: { message?: string; code?: string; data?: unknown };
}

/** Callbacks the core registers with an adapter for the connection lifecycle. */
export interface AdapterHandlers {
  onOpen(): void;
  onClose(reason?: unknown): void;
  onError(err: unknown): void;
  onEvent(event: NormalizedEvent): void;
  /**
   * Deliver a reply to a client-initiated request. The core always provides this; an adapter that
   * implements the optional `request` capability calls it when a correlated reply arrives.
   */
  onReply?(reply: ReplyFrame): void;
}

/** A request to subscribe to a channel, encoded and sent by the adapter. */
export interface SubscribeRequest {
  subId: string;
  channel: string;
  params?: Record<string, unknown>;
}

/**
 * A client→server, fire-and-forget command. Carried upstream by adapters that implement the
 * optional `publish` capability; an adapter over a one-way transport (e.g. SSE) routes it through
 * its own write channel.
 */
export interface PublishRequest {
  channel: string;
  event: string;
  payload: unknown;
  /** Optional out-of-band metadata (correlation, headers, …) forwarded verbatim to the server. */
  meta?: Record<string, unknown>;
  /** Optional client-supplied key so the server can dedupe a command delivered more than once. */
  idempotencyKey?: string;
}

/**
 * A client→server request that expects a correlated reply (RPC). The core generates `requestId`,
 * tracks the pending promise, and matches the server's {@link ReplyFrame} back to it.
 */
export interface RequestFrame {
  requestId: string;
  channel: string;
  event: string;
  payload: unknown;
  /** Optional out-of-band metadata forwarded verbatim to the server. */
  meta?: Record<string, unknown>;
  /** Optional client-supplied key so the server can dedupe a request delivered more than once. */
  idempotencyKey?: string;
}

/**
 * A protocol adapter turns a live connection into a normalized event stream.
 * One adapter per wire protocol; the backend's language is irrelevant.
 */
export interface StreamAdapter {
  connect(handlers: AdapterHandlers): void;
  disconnect(): void;
  subscribe(sub: SubscribeRequest): void;
  unsubscribe(subId: string): void;
  heartbeat?(): void;
  resume?(subId: string, cursor: Cursor | null): void;
  /**
   * Send a fire-and-forget command upstream. Optional capability: an adapter over a transport with
   * no client→server path omits it, and `LivefluxClient.publish` then throws a `ConnectionError`.
   */
  publish?(req: PublishRequest): void;
  /**
   * Send a correlated request upstream and, when the reply arrives, deliver it via
   * `AdapterHandlers.onReply`. Optional capability: omitted by adapters that can't do request/reply,
   * and `LivefluxClient.request` then rejects with a `ConnectionError`.
   */
  request?(req: RequestFrame): void;
}
