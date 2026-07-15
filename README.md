# Liveflux

**Typed, reconnect-safe realtime streaming state for the frontend.**

Liveflux turns a live connection — WebSocket, Phoenix Channels, and other push transports — into
declarative, typed UI state. It's **protocol-agnostic** (via adapters) and **framework-agnostic**
(via bindings), so you stop hand-rolling sockets, cache glue, dedup, backpressure, and reconnect
logic.

> **Status: pre-alpha, building in the open.** The API described here is real and tested; it is
> being prepared for its first npm release.

## Why

A realtime feature looks small until you ship it. The moment a socket is involved you re-write the
same plumbing every time: connect / detect drops / reconnect with backoff / re-subscribe without
losing or duplicating data; multiplex many subscriptions over one socket; fold a raw event stream
into the shape a component renders; guard the send buffer under load; and read changing external
state in React without tearing. Liveflux owns all of that behind a small typed surface.

## Install

Pick the engine, a transport adapter, and your framework binding:

```bash
npm install @liveflux/core @liveflux/ws @liveflux/react
```

Talking to a Phoenix backend? Swap `@liveflux/ws` for `@liveflux/phoenix` — nothing else changes.

## Quickstart

```tsx
// main.tsx — one client for the whole app, over your realtime backend
import { LivefluxClient } from '@liveflux/core';
import { LivefluxProvider } from '@liveflux/react';
import { ws } from '@liveflux/ws';

const client = new LivefluxClient({ adapter: ws('wss://example.com/socket') });
client.connect();

createRoot(document.getElementById('root')!).render(
  <LivefluxProvider client={client}>
    <App />
  </LivefluxProvider>,
);
```

```tsx
// App.tsx — subscribe to a channel and fold its events into state
import { useStream } from '@liveflux/react';

type Trade = { id: number; symbol: string; price: number };

export function App() {
  // upsert → Trade[]: a matching id updates in place, a new id is appended.
  const trades = useStream<Trade>({
    channel: 'trades',
    into: { strategy: 'upsert', key: 'id', cap: 50 },
  });

  return trades.map((t) => <Row key={t.id} symbol={t.symbol} price={t.price} />);
}
```

The wire subscription is multiplexed onto one connection, deduped, and re-sent automatically after
a reconnect — you wrote none of that.

## Packages

| Package                   | Description                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `@liveflux/core`          | Framework-agnostic engine — connection lifecycle, subscriptions, store, backpressure.             |
| `@liveflux/ws`            | Generic WebSocket adapter. Works with any plain-WebSocket backend, in any language.               |
| `@liveflux/phoenix`       | Phoenix Channels (v2) adapter — joins, rejoin backoff, and the `phoenix` heartbeat topic.         |
| `@liveflux/react`         | React binding — the `useStream` hook (tear-free via `useSyncExternalStore`) + `LivefluxProvider`. |
| `@liveflux/adapter-tests` | Shared conformance suite + a mock adapter, so every adapter is held to the same contract.         |

## What you get

- **Reconnect-safe** — exponential backoff with jitter, then every active subscription is replayed
  on the new connection. Streams resume on their own.
- **One multiplexed connection** — many subscriptions share a single socket; identical
  subscriptions fold once, ref-counted.
- **Cache-shaped state** — fold events with `append` (log), `upsert` (keyed list), `replace`
  (latest), or your own `reducer`.
- **Backpressure** — adapters queue control frames past a send-buffer high-water mark and drop
  oversized inbound frames before decoding.
- **Tear-free React** — reads go through `useSyncExternalStore`; pass a selector to re-render only
  on the slice you use.
- **Typed end-to-end** — the return type follows the strategy, from channel to component.

## Documentation

Full guide, concepts, and a live demo: **[liveflux.bpdm.dev](https://liveflux.bpdm.dev)**
· [Getting Started](https://liveflux.bpdm.dev/docs/getting-started)
· [Concepts](https://liveflux.bpdm.dev/docs/concepts)

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT © [`<BPDM/>`](https://bpdm.dev)
