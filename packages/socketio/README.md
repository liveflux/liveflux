# @liveflux/socketio

The **Socket.IO** adapter for [Liveflux](https://liveflux.bpdm.dev) — wrap a Socket.IO client `Socket`
you already have into a normalized, reconnect-safe event stream for `@liveflux/core`.

> **New to Liveflux?** Start with `pnpm create liveflux@latest` — it picks your framework binding and transport and wires everything up for you.

- **Bring your own socket.** Your transport upgrade, rooms, and auth stay yours — this only maps the
  lifecycle and a stream event onto the core's contract.
- **Zero bundled dependencies.** `socket.io-client` is an optional peer you provide; the adapter
  never imports it (it types against a structural `SocketLike`), so nothing extra ships.
- **Reconnect-safe.** The active subscription set is re-emitted on every (re)connect.
- **Configurable & secure by default.** Choose the inbound event name and decoder; the default
  decoder accepts only well-formed events.

```ts
import { io } from 'socket.io-client';
import { LivefluxClient } from '@liveflux/core';
import { socketio } from '@liveflux/socketio';

// Let the core own reconnect (one backoff policy) — disable Socket.IO's own retry.
const socket = io('https://example.com', { reconnection: false });

const client = new LivefluxClient({ adapter: socketio(socket) });
client.connect();
```

## Wire contract

| Direction | Default | Payload |
| --- | --- | --- |
| inbound (server → client) | event `message` | `{ channel, event, payload, cursor?, meta? }` |
| subscribe | emit `subscribe` | `{ subId, channel, params? }` |
| unsubscribe | emit `unsubscribe` | `{ subId }` |
| resume | emit `resume` | `{ subId, cursor }` |

Override the inbound event with `eventName`, the control events with `subscribeEvent` /
`unsubscribeEvent` / `resumeEvent`, and the inbound shape with `decode`.

## License

MIT
