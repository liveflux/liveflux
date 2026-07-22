# @liveflux/ws

The generic **WebSocket** adapter for [Liveflux](https://liveflux.bpdm.dev) — works with any backend
that exposes a plain WebSocket, in any language. Turns a raw socket into a normalized, reconnect-safe
event stream for `@liveflux/core`.

> **New to Liveflux?** Start with `pnpm create liveflux@latest` — it picks your framework binding and transport and wires everything up for you.

- **Backend-agnostic.** No wire-protocol assumptions — bring your own `encode`/`decode`.
- **Zero runtime dependencies**, tree-shakeable, tiny.
- **Reconnect-safe.** The active subscription set is re-sent on every reopen.
- **Configurable & secure by default.** Injectable `WebSocket`, outbound backpressure, and an
  inbound message-size guard.

## Install

```sh
pnpm add @liveflux/ws @liveflux/core
```

`@liveflux/core` is a peer dependency.

## Usage

```ts
import { LivefluxClient } from '@liveflux/core';
import { ws } from '@liveflux/ws';

const client = new LivefluxClient({
  adapter: ws('wss://api.example.com/socket'),
});
```

In Node (or tests) where there is no global `WebSocket`, inject one:

```ts
import WebSocket from 'ws';

ws('wss://api.example.com/socket', { WebSocket });
```

See the full documentation at [liveflux.bpdm.dev](https://liveflux.bpdm.dev).

## License

MIT © [Bhavin Devamorari](https://bpdm.dev)
