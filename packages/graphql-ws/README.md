# @liveflux/graphql-ws

The **graphql-transport-ws** adapter for [Liveflux](https://liveflux.bpdm.dev) — GraphQL subscriptions
over WebSocket, turned into a normalized, reconnect-safe event stream for `@liveflux/core`.

> **New to Liveflux?** Start with `pnpm create liveflux@latest` — it picks your framework binding and transport and wires everything up for you.

- **Speaks the protocol directly** — no GraphQL client to bundle. **Zero runtime dependencies**, tree-shakeable, tiny.
- **Channel → subscription.** A liveflux channel maps to a GraphQL subscription document (override with `query`); each `next` result is routed back to its channel and normalized.
- **Reconnect-safe.** The core owns reconnect; active subscriptions are replayed after each `connection_ack`. `ping` is answered with `pong`.
- **Secure by default.** Inbound size cap; only well-formed typed messages are acted on. Injectable `WebSocket`; `connectionParams` for auth.

```ts
import { LivefluxClient } from '@liveflux/core';
import { graphqlWs } from '@liveflux/graphql-ws';

const client = new LivefluxClient({
  adapter: graphqlWs('wss://example.com/graphql', {
    // a channel is the subscription document; params are its variables (both overridable)
    query: (channel, params) => ({ query: channel, variables: params }),
    connectionParams: () => ({ authToken: getToken() }),
  }),
});
client.connect();
```

Subscribe to a channel whose name is a subscription document:

```ts
client.subscribe({
  channel: 'subscription OnTrade($sym: String!) { trade(symbol: $sym) { id price } }',
  params: { sym: 'ACME' },
  into: { strategy: 'upsert', key: 'id' },
});
```

## License

MIT
