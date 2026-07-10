# @liveflux/adapter-tests

The Liveflux **testing moat** — two tools with zero runtime dependencies:

- **`MockAdapter`** — a fully programmable `StreamAdapter` with no real socket and no timers. Use it
  to drive `@liveflux/core` (and framework bindings) deterministically: you play the server through
  a tiny synchronous control surface, and every call the core makes on the adapter is recorded for
  inspection.
- **`runAdapterConformance`** — a shared, protocol-agnostic suite that proves any adapter honours the
  core `StreamAdapter` contract identically. Every adapter package runs the same suite against its
  own transport, guaranteeing cross-adapter parity.

Both are tree-shakeable: importing `MockAdapter` alone pulls in no test-runner code, so it adds
nothing to a production bundle. The conformance suite runs under the consumer's own Vitest.

## Install

```sh
pnpm add -D @liveflux/adapter-tests
```

`@liveflux/core` and `vitest` are peer dependencies.

## `MockAdapter`

```ts
import { MockAdapter } from '@liveflux/adapter-tests';
import { LivefluxClient } from '@liveflux/core';

const adapter = new MockAdapter();
const client = new LivefluxClient({ adapter });

client.connect();
adapter.open(); // complete the handshake → the client is now "open"

const sub = client.subscribe({ channel: 'orders', into: { strategy: 'append' } });

// Play the server:
adapter.emit({ channel: 'orders', event: 'insert', payload: { id: 1 }, cursor: 'c-1' });
adapter.drop(); // an unexpected close → the client reconnects; the next open() replays active subs

// Inspect what the core did:
adapter.subscriptions; // active SubscribeRequests
adapter.subscribeLog; // every subscribe frame sent (incl. reconnect replays)
adapter.unsubscribeLog; // subIds an unsubscribe was sent for
adapter.resumeLog; // recorded resume(subId, cursor) calls
adapter.lastCursor('sub_1'); // last cursor observed for that subscription's channel
```

### Control surface

| Method          | Effect                                                             |
| --------------- | ------------------------------------------------------------------ |
| `open()`        | Fire `onOpen` and replay the active subscription set.              |
| `emit(event)`   | Deliver one event to `onEvent` (only while open).                  |
| `drop(reason?)` | Simulate an unexpected close → `onClose`; the active set is kept.  |
| `fail(err)`     | Simulate a transport error → `onError`.                            |

Everything is synchronous and deterministic — no fake timers needed unless the code under test
schedules its own work.

## `runAdapterConformance`

Call it at the top level of a test file in your adapter's package, giving it a `setup` that builds a
fresh adapter plus a **harness** describing how to play the server for that transport and how to read
back what it sent (decoded to the core's transport-neutral shapes).

```ts
import { runAdapterConformance } from '@liveflux/adapter-tests';
import { myAdapter } from './index';

runAdapterConformance({
  name: '@liveflux/my-adapter',
  setup() {
    const server = createFakeServer();
    const adapter = myAdapter(server.url);
    return {
      adapter,
      open: () => server.accept(),
      emit: (event) => server.send(event),
      drop: (reason) => server.close(reason),
      sentSubscribes: () => server.decodedSubscribes(),
      sentUnsubscribes: () => server.unsubscribedSubIds(),
      // Provide `sentResumes` only if the adapter implements the optional `resume` capability.
    };
  },
});
```

### The contract it proves

1. **connect → onOpen.**
2. **subscribe** encodes a faithful `SubscribeRequest` (params included).
3. an inbound server event **surfaces as a normalized `onEvent`** (channel / event / payload /
   cursor / meta preserved).
4. **unsubscribe** sends its frame and is **not replayed** on the next reconnect. (Event _filtering_
   is the core's job — the registry drops events for channels with no listeners; the adapter's
   guarantee is the wire teardown plus no replay.)
5. an unexpected **drop → `onClose`**, then reconnect **re-subscribes the active set**. The core
   reacts to a close by calling `connect` again — never `subscribe` — so replaying active
   subscriptions on the fresh connection is the adapter's responsibility.
6. **resume-from-cursor** (optional, v0.2): if the adapter implements `resume`, calling
   `resume(subId, cursor)` transmits a gap-recovery frame carrying exactly that cursor (and a `null`
   cursor for a from-scratch resync). Adapters without the capability skip this scenario.
7. **disconnect** cleans up: no server activity reaches the handlers afterward.

## License

MIT © [Bhavin Devamorari](https://bpdm.dev)
