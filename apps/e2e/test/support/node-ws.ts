import { WebSocket } from 'ws';
import type { WsOptions } from '@liveflux/ws';
import type { PhoenixOptions } from '@liveflux/phoenix';

/**
 * The Node `ws` client, typed for each adapter's `WebSocket` option. The `ws` package implements the
 * browser-compatible surface the adapters rely on (`onopen`/`onmessage`/`onclose`/`onerror`,
 * `readyState`, `bufferedAmount`, `send`, `close`), so it drops straight in where a browser would
 * otherwise provide `globalThis.WebSocket`.
 */
export const WsClientCtor = WebSocket as unknown as NonNullable<WsOptions['WebSocket']>;
export const PhoenixClientCtor = WebSocket as unknown as NonNullable<PhoenixOptions['WebSocket']>;
