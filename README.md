# Liveflux

**Typed, cache-integrated, reconnect-safe realtime streaming state for the frontend.**

Liveflux is protocol-agnostic (via adapters) and framework-agnostic (via bindings): it turns a
live connection — WebSocket, SSE, and other push transports — into declarative UI state, so you
stop hand-rolling sockets, cache glue, dedup, backpressure, and reconnect logic.

> Status: pre-alpha, building in the open.

## Packages

| Package | Description |
| --- | --- |
| `@liveflux/core` | Framework-agnostic engine (connection, subscriptions, store, backpressure) |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT © Bhavin Devamorari
