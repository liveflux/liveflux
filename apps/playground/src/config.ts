// Shared playground constants. The mock server (server.mjs) and the app both point here so the
// connection URL and channel name never drift apart.

/** The local mock WebSocket backend (server.mjs). Digits of the port sum to 9. */
export const WS_URL = 'ws://localhost:8100';

/** The single demo channel every fold-strategy tab subscribes to. */
export const CHANNEL = 'trades';
