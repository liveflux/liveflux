import { ConnectionManager, type HeartbeatPolicy } from '../internal/connection/connection-manager';
import type { ReconnectPolicy } from '../internal/connection/reconnect';
import { SubscriptionRegistry } from '../internal/subscriptions/subscription-registry';
import { Store, type IntoStrategy } from '../internal/store/store';
import type { ConnectionState, StreamAdapter } from '../types';

export interface LivefluxClientOptions {
  /** The protocol adapter (WebSocket, Phoenix Channels, …). */
  adapter: StreamAdapter;
  /** Reconnection tuning (exponential backoff + jitter). */
  reconnect?: Partial<ReconnectPolicy>;
  /** Heartbeat keepalive tuning. */
  heartbeat?: Partial<HeartbeatPolicy>;
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

/**
 * The context layer for `@liveflux/core`.
 *
 * Composes the connection lifecycle, the subscription registry, and per-subscription stores behind
 * a single surface. Consumers and framework bindings talk **only** to this — `ConnectionManager`,
 * `SubscriptionRegistry`, and `Store` are internal implementation details.
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
   * Subscribe to a channel and fold its events into state via the chosen strategy. The wire
   * subscription is multiplexed + ref-counted; the returned `Subscription` exposes the derived
   * state (`getState`), a change subscription (`subscribe`), and teardown (`destroy`).
   */
  subscribe<T, S = T>(config: SubscribeConfig<T, S>): Subscription<T, S> {
    const store = new Store<T, S>(config.into);
    const off = this.registry.subscribe(
      config.channel,
      (event) => store.apply(event),
      config.params,
    );
    // Frozen so the returned handle can't be tampered with (its methods reassigned) by a consumer.
    return Object.freeze({
      getState: () => store.getState(),
      subscribe: (listener: () => void) => store.subscribe(listener),
      destroy: off,
    });
  }

  /** Tear everything down: unsubscribe every channel and close the connection. */
  destroy(): void {
    this.registry.clear();
    this.connection.close();
  }
}
