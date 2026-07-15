# @liveflux/phoenix

The **Phoenix Channels** adapter for [Liveflux](https://liveflux.bpdm.dev) — turns an Elixir Phoenix
Channels connection into a normalized, reconnect-safe event stream for the core engine.

- **Phoenix v2 serializer, hand-rolled.** Speaks the wire protocol directly (`[join_ref, ref, topic,
event, payload]`) — it does **not** depend on the `phoenix` npm package.
- **Zero runtime dependencies**, tree-shakeable, tiny (size-limited in CI).
- **Reconnect-safe.** The active subscription set is re-joined on every reopen — the core never
  re-subscribes by hand. A crashed channel (`phx_error`) is transparently re-joined, a stalled join
  is retried, and a zombie socket (missed heartbeat) is torn down so the core reconnects.
- **Configurable & secure by default.** Injectable `WebSocket`, custom `encode` / `decode`, dynamic
  connect params, outbound backpressure, and an inbound message-size guard.

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

Pass `params` as a **function** to re-authenticate on every (re)connect — it is called each time a
socket is opened, so a rotated/refreshed token is always current:

```ts
phoenix('wss://api.example.com/socket', {
  params: () => ({ token: getFreshToken() }), // re-read on every connect / reconnect
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

| Option              | Type                                                   | Default                       | Description                                                                                                                                              |
| ------------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`            | `Record<string, string> \| (() => Record<string, string>)` | —                        | Socket-level connect params appended to the URL query (e.g. an auth token). A **function** is re-invoked on every (re)connect, so a rotated token re-auths each new socket; an object is read once per connect. |
| `vsn`               | `string`                                               | `"2.0.0"`                     | Serializer version negotiated via the `vsn` query param (the v2 serializer).                                                                            |
| `encode`            | `(message: PhoenixMessage) => string`                  | `JSON.stringify`              | Serialize an outbound message tuple to a wire string.                                                                                                   |
| `decode`            | `(message: PhoenixMessage) => NormalizedEvent \| null` | `{ channel, event, payload }` | Map an inbound **data** message (control frames are handled internally) to a `NormalizedEvent`, or `null` to ignore it.                                 |
| `maxBufferedAmount` | `number`                                               | `1048576` (1 MiB)             | Outbound backpressure high-water mark (bytes). Above it, frames queue and flush as the buffer drains; heartbeats are dropped rather than queued.        |
| `maxMessageBytes`   | `number`                                               | `1048576` (1 MiB)             | Drop inbound string frames longer than this (measured as UTF-16 string length, an approximation of bytes) before parsing (DoS bound). Set `0` to disable. |
| `joinTimeoutMs`     | `number`                                               | `10000`                       | Per-join reply timeout. A `phx_join` with no `phx_reply` in this window has its pending entry cleared and is retried with capped backoff.               |
| `rejoinDelayMs`     | `number`                                               | `50`                          | Base backoff before re-joining a channel after a `phx_error` or join timeout; doubles per consecutive attempt, reset on success.                        |
| `maxRejoinDelayMs`  | `number`                                               | `5000`                        | Cap for the exponential re-join backoff.                                                                                                                |
| `WebSocket`         | `WebSocketCtor`                                        | `globalThis.WebSocket`        | WebSocket constructor. Inject for Node or tests.                                                                                                        |

## Wire protocol

Each message is a Phoenix **v2** five-tuple `[join_ref, ref, topic, event, payload]`:

| Concept             | Mapping                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Liveflux `channel`  | Phoenix **topic**.                                                                                                                 |
| `join_ref`          | A **composite** `` `${subId}#${instance}` `` — a fresh instance per join, recoverable to the `subId`, so a late frame from a superseded channel instance (after a re-join) is told apart from the live one and dropped. |
| `ref`               | A monotonic per-connection request id; correlates a reply to its request. Reset on every (re)connect.                             |
| **subscribe**       | `[join_ref, ref, channel, "phx_join", params]`.                                                                                   |
| **unsubscribe**     | `[join_ref, ref, channel, "phx_leave", {}]`. Removed from the active set → not re-joined on reconnect.                            |
| **heartbeat**       | `[null, ref, "phoenix", "heartbeat", {}]` — the core drives the interval; dropped rather than queued under load.                  |
| **reply** (inbound) | `[join_ref, ref, topic, "phx_reply", { status, response }]` — correlated by `ref`; a `status: "error"` join → `onError`. A reply naming a superseded instance is ignored. |
| **event** (inbound) | `[null, null, topic, event, payload]` → `onEvent({ channel: topic, event, payload })` for the active sub on that topic (routed by topic in O(1)). |
| **`phx_error`**     | Channel crashed server-side → surfaced via `onError({ type: "channel_error", channel })`, then **transparently re-joined** with capped backoff (a stale one, from a superseded instance, is ignored). |
| **`phx_close`**     | Graceful close after a leave — consumed, no action.                                                                               |

### Reconnect

The core reacts to a close by calling `connect()` again on a fresh socket. On the new connection the
adapter re-joins every currently-active subscription (with a fresh `ref` sequence and fresh join
instances), so no state is lost. Unsubscribed channels are not replayed.

### Channel-level resilience

Beyond connection-level reconnect (the core's job), the adapter keeps individual channels alive:

- **`phx_error` → re-join.** A server-side channel crash is surfaced via
  `onError({ type: 'channel_error', channel })` and then transparently re-joined on the same socket,
  spaced by capped exponential backoff (`rejoinDelayMs` → `maxRejoinDelayMs`) so a crash-looping
  channel cannot hot-spin. The backoff counter resets on a successful join. Without this the socket
  would stay open with a dead subscription and the core would never reconnect.
- **Join timeout → retry.** A `phx_join` with no `phx_reply` within `joinTimeoutMs` has its pending
  entry cleared (no leak) and is retried through the same backoff path.
- **Stale-instance filtering.** Each join instance carries a fresh `join_ref`, so a `phx_reply` /
  `phx_error` / `phx_close` naming a superseded instance (its `join_ref` no longer current) is
  ignored — a late frame from a crashed channel can't trigger a spurious error or re-join loop.

### Heartbeat & dead-link detection

The core drives the heartbeat _interval_ (enable `heartbeat` in its connection options) by calling
`adapter.heartbeat()`. The adapter records the outstanding heartbeat `ref` and clears it when the
matching `phx_reply` on the `phoenix` topic arrives. If the previous heartbeat is still unacked on
the next tick, the link is treated as dead: the socket is closed, which fires `onClose` and lets the
core reconnect. This detects a half-open ("zombie") socket that never surfaces a TCP close.

### Gap recovery / `cursor`

Phoenix Channels have no native since-cursor, so this adapter does **not** implement the optional
`resume` capability (v0.2 gap recovery). If your server emits gap tokens inside the event payload,
provide a custom `decode` that lifts them onto `NormalizedEvent.cursor` / `.meta`.

See the full documentation at [liveflux.bpdm.dev](https://liveflux.bpdm.dev).

## License

MIT © [Bhavin Devamorari](https://bpdm.dev)
