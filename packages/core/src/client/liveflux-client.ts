import { ConnectionManager, type HeartbeatPolicy } from '../internal/connection/connection-manager';
import type { ReconnectPolicy } from '../internal/connection/reconnect';
import {
  SubscriptionRegistry,
  type EventListener,
} from '../internal/subscriptions/subscription-registry';
import type { ConnectionState, StreamAdapter } from '../types';

export interface LivefluxClientOptions {
  /** The protocol adapter (WebSocket, Phoenix Channels, …). */
  adapter: StreamAdapter;
  /** Reconnection tuning (exponential backoff + jitter). */
  reconnect?: Partial<ReconnectPolicy>;
  /** Heartbeat keepalive tuning. */
  heartbeat?: Partial<HeartbeatPolicy>;
}

/**
 * The context layer for `@liveflux/core`.
 *
 * Composes the connection lifecycle and the subscription registry behind a single surface.
 * Consumers and framework bindings talk **only** to this — `ConnectionManager` and
 * `SubscriptionRegistry` are internal implementation details, never exported from the package.
 */
export class LivefluxClient {
  private readonly connection: ConnectionManager;
  private readonly registry: SubscriptionRegistry;

  constructor(opts: LivefluxClientOptions) {
    this.registry = new SubscriptionRegistry(opts.adapter);
    this.connection = new ConnectionManager({
      adapter: opts.adapter,
      reconnect: opts.reconnect,
      heartbeat: opts.heartbeat,
      onEvent: (event) => this.registry.handleEvent(event),
    });
  }

  /** Open the connection. No-op while already connecting/open. */
  connect(): void {
    this.connection.connect();
  }

  /** Current connection state. */
  getConnectionState(): ConnectionState {
    return this.connection.getState();
  }

  /** Subscribe to connection-state transitions. Returns an unsubscribe function. */
  onConnectionChange(
    listener: (state: ConnectionState, previous: ConnectionState) => void,
  ): () => void {
    return this.connection.onStateChange(listener);
  }

  /**
   * Subscribe to a channel. Multiplexed + ref-counted: many subscribers to the same channel share
   * one wire subscription. Returns an idempotent unsubscribe function.
   */
  subscribe(
    channel: string,
    listener: EventListener,
    params?: Record<string, unknown>,
  ): () => void {
    return this.registry.subscribe(channel, listener, params);
  }

  /** Tear everything down: unsubscribe every channel and close the connection. */
  destroy(): void {
    this.registry.clear();
    this.connection.close();
  }
}
