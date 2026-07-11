# @liveflux/phoenix

The **Phoenix Channels** adapter for [Liveflux](https://liveflux.io) — turns an Elixir Phoenix
Channels connection into a normalized, reconnect-safe event stream for the core engine.

- **Phoenix v2 serializer, hand-rolled.** Speaks the wire protocol directly (`[join_ref, ref, topic,
event, payload]`) — it does **not** depend on the `phoenix` npm package.
- **Zero runtime dependencies**, tree-shakeable, tiny (size-limited in CI).
- **Reconnect-safe.** The active subscription set is re-joined on every reopen — the core never
  re-subscribes by hand.
- **Configurable & secure by default.** Injectable `WebSocket`, custom `encode` / `decode`, outbound
  backpressure, and an inbound message-size guard.

## Install

```sh
pnpm add @liveflux/phoenix @liveflux/core
```

`@liveflux/core` is a peer dependency.

## Usage

```ts
import { LivefluxClient } from '@liveflux/core';
import { phoenix } from '@liveflux/phoenix';

const client = new LivefluxClient({
  adapter: phoenix('wss://api.example.com/socket', {
    params: { token: authToken }, // socket-level connect params → Phoenix `connect/3`
  }),
});
```

In Node (or tests) where there is no global `WebSocket`, inject one:

```ts
import WebSocket from 'ws';

phoenix('wss://api.example.com/socket', { WebSocket });
```

## `phoenix(url, options?)`

Returns a `StreamAdapter`. The `url` is your Phoenix socket endpoint (e.g. `wss://host/socket`); the
serializer version and any connect params are appended to the query string.

### `PhoenixOptions`

| Option              | Type                                                   | Default                       | Description                                                                                                                                      |
| ------------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `params`            | `Record<string, string>`                               | —                             | Socket-level connect params appended to the URL query (e.g. an auth token). Carried, never invented — Liveflux passes through the app's scheme.  |
| `vsn`               | `string`                                               | `"2.0.0"`                     | Serializer version negotiated via the `vsn` query param (the v2 serializer).                                                                     |
| `encode`            | `(message: PhoenixMessage) => string`                  | `JSON.stringify`              | Serialize an outbound message tuple to a wire string.                                                                                            |
| `decode`            | `(message: PhoenixMessage) => NormalizedEvent \| null` | `{ channel, event, payload }` | Map an inbound **data** message (control frames are handled internally) to a `NormalizedEvent`, or `null` to ignore it.                          |
| `maxBufferedAmount` | `number`                                               | `1048576` (1 MiB)             | Outbound backpressure high-water mark (bytes). Above it, frames queue and flush as the buffer drains; heartbeats are dropped rather than queued. |
| `maxMessageBytes`   | `number`                                               | `1048576` (1 MiB)             | Drop inbound string frames longer than this before parsing (DoS bound). Set `0` to disable.                                                      |
| `WebSocket`         | `WebSocketCtor`                                        | `globalThis.WebSocket`        | WebSocket constructor. Inject for Node or tests.                                                                                                 |

## Wire protocol

Each message is a Phoenix **v2** five-tuple `[join_ref, ref, topic, event, payload]`:

| Concept             | Mapping                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Liveflux `channel`  | Phoenix **topic**.                                                                                                         |
| Liveflux `subId`    | Used verbatim as that topic's **`join_ref`** — a stable, opaque per-subscription join token (self-correlating replies).    |
| `ref`               | A monotonic per-connection request id; correlates a reply to its request. Reset on every (re)connect.                      |
| **subscribe**       | `[subId, ref, channel, "phx_join", params]`.                                                                               |
| **unsubscribe**     | `[subId, ref, channel, "phx_leave", {}]`. Removed from the active set → not re-joined on reconnect.                        |
| **heartbeat**       | `[null, ref, "phoenix", "heartbeat", {}]` — the core drives the interval; dropped rather than queued under load.           |
| **reply** (inbound) | `[join_ref, ref, topic, "phx_reply", { status, response }]` — correlated by `ref`; a `status: "error"` join → `onError`.   |
| **event** (inbound) | `[join_ref, ref, topic, event, payload]` → `onEvent({ channel: topic, event, payload })` for the active sub on that topic. |
| **`phx_error`**     | Channel crashed server-side → surfaced via `onError`. (Connection-level reconnect is the core's job.)                      |
| **`phx_close`**     | Graceful close after a leave — consumed, no action.                                                                        |

### Reconnect

The core reacts to a close by calling `connect()` again on a fresh socket. On the new connection the
adapter re-joins every currently-active subscription (with a fresh `ref` sequence), so no state is
lost. Unsubscribed channels are not replayed.

### Gap recovery / `cursor`

Phoenix Channels have no native since-cursor, so this adapter does **not** implement the optional
`resume` capability (v0.2 gap recovery). If your server emits gap tokens inside the event payload,
provide a custom `decode` that lifts them onto `NormalizedEvent.cursor` / `.meta`.

## License

MIT © [Bhavin Devamorari](https://bpdm.dev)
