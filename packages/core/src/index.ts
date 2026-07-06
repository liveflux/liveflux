/**
 * @liveflux/core — framework-agnostic realtime streaming engine.
 *
 * This barrel is the ENTIRE public API surface. Everything else under `src/` is internal:
 *   • ConnectionManager, SubscriptionRegistry — implementation details, driven by the client
 *   • reconnect helpers (backoffDelay, resolveReconnectPolicy, defaults) — internal
 * Consumers and framework bindings interact only through `LivefluxClient` (the context layer)
 * plus the shared contracts and config types below.
 */

/**
 * The context layer (public entry point)
 */
export { LivefluxClient } from './client/liveflux-client';
export type { LivefluxClientOptions } from './client/liveflux-client';

/**
 * Contracts (implemented by adapter authors, consumed by bindings)
 */
export type {
  Id,
  Cursor,
  ConnectionState,
  NormalizedEvent,
  AdapterHandlers,
  SubscribeRequest,
  StreamAdapter,
} from './types';
export type { EventListener } from './internal/subscriptions/subscription-registry';

/**
 * Public configuration
 */
export type { ReconnectPolicy } from './internal/connection/reconnect';
export type { HeartbeatPolicy } from './internal/connection/connection-manager';
export type { IntoStrategy } from './internal/store/store';
