# @liveflux/sse

The **Server-Sent Events** adapter for [Liveflux](https://liveflux.bpdm.dev) — works with any backend
that exposes an SSE endpoint, in any language. Turns a standard `EventSource` into a normalized,
reconnect-safe event stream for `@liveflux/core`.

> **New to Liveflux?** Start with `pnpm create liveflux@latest` — it picks your framework binding and transport and wires everything up for you.

- **Backend-agnostic.** The downstream stream is a plain `EventSource`; bring your own `encode`/`decode`.
- **Zero runtime dependencies**, tree-shakeable, tiny.
- **Reconnect-safe.** The core owns reconnect (one backoff policy, not the browser's opaque retry); the active subscription set is replayed on every reopen.
- **Cursor resume.** `resume(subId, cursor)` sends a gap-recovery frame, and the default decoder threads the SSE `lastEventId` through as the cursor.
- **Configurable & secure by default.** Injectable `EventSource`/`fetch`, an inbound size cap, and a decoder that only accepts well-formed events.

## Why a control channel?

SSE is one-way (server → client). Subscribe / unsubscribe / resume therefore go **upstream** over a
separate channel — by default an HTTP `POST` alongside the stream (override with `control`, or hand it
your own transport function).

```ts
import { LivefluxClient } from '@liveflux/core';
import { sse } from '@liveflux/sse';

const client = new LivefluxClient({
  adapter: sse('/events', { control: '/events/control' }),
});
client.connect();
```

## Options

| Option | Description |
| --- | --- |
| `control` | Upstream target for subscribe/unsubscribe/resume: a URL (POSTed as JSON), a function (your own transport), or omitted (POST to the stream URL). |
| `withCredentials` | Send cookies with the stream request. |
| `EventSource` | Inject an `EventSource` implementation (Node / tests). |
| `fetch` | Inject `fetch` for the default control POST. |
| `encode` / `decode` | Override the control-frame encoder and the inbound decoder. |
| `maxMessageBytes` | Drop inbound frames larger than this before decoding (default 1 MiB; `0` disables). |

Pass `url` as a function to re-resolve it (e.g. a rotated token) on every reconnect.

## License

MIT
