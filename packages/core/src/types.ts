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

/** Callbacks the core registers with an adapter for the connection lifecycle. */
export interface AdapterHandlers {
  onOpen(): void;
  onClose(reason?: unknown): void;
  onError(err: unknown): void;
  onEvent(event: NormalizedEvent): void;
}

/** A request to subscribe to a channel, encoded and sent by the adapter. */
export interface SubscribeRequest {
  subId: string;
  channel: string;
  params?: Record<string, unknown>;
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
}
