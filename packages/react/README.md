# @liveflux/react

The React binding for [Liveflux](https://liveflux.bpdm.dev) — the `useStream` hook for typed,
reconnect-safe realtime state. Reads go through `useSyncExternalStore`, so they are tear-free and
safe under concurrent rendering.

## Install

```sh
pnpm add @liveflux/react @liveflux/core
# plus a transport adapter, e.g.
pnpm add @liveflux/ws
```

`@liveflux/core` and `react` (`>=18`) are peer dependencies.

## Usage

```tsx
import { LivefluxClient } from '@liveflux/core';
import { ws } from '@liveflux/ws';
import { LivefluxProvider, useStream } from '@liveflux/react';

const client = new LivefluxClient({ adapter: ws('wss://api.example.com/socket') });

function App() {
  return (
    <LivefluxProvider client={client}>
      <Orders />
    </LivefluxProvider>
  );
}

function Orders() {
  const orders = useStream<Order>({ channel: 'orders', into: { strategy: 'append' } });
  return <ul>{orders.map((o) => <li key={o.id}>{o.id}</li>)}</ul>;
}
```

Pass a `select` to subscribe to a derived slice and re-render only when it changes — the key
optimization for high-frequency streams. See the full documentation at
[liveflux.bpdm.dev](https://liveflux.bpdm.dev).

## License

MIT © [Bhavin Devamorari](https://bpdm.dev)
