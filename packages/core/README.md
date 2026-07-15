# @liveflux/core

The framework-agnostic core engine of [Liveflux](https://liveflux.bpdm.dev) — connection lifecycle,
multiplexed subscriptions, folded state store, and backpressure. Type-safe, cache-integrated, and
reconnect-safe realtime streaming state for the frontend.

It owns a single multiplexed connection and drives a pluggable transport `StreamAdapter`; pair it
with one of the adapters below.

## Install

```sh
pnpm add @liveflux/core
# plus a transport adapter, e.g.
pnpm add @liveflux/ws       # any plain WebSocket backend
pnpm add @liveflux/phoenix  # Elixir Phoenix Channels
```

Framework bindings build on top:

```sh
pnpm add @liveflux/react    # the useStream hook
```

## Usage

```ts
import { LivefluxClient } from '@liveflux/core';
import { ws } from '@liveflux/ws';

const client = new LivefluxClient({
  adapter: ws('wss://api.example.com/socket'),
});

client.connect();

const sub = client.subscribe({ channel: 'orders', into: { strategy: 'append' } });
sub.subscribe((orders) => console.log(orders));
```

See the full documentation at [liveflux.bpdm.dev](https://liveflux.bpdm.dev).

## License

MIT © [Bhavin Devamorari](https://bpdm.dev)
