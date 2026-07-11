# e2e — Liveflux end-to-end / integration suite

A test-only workspace member (`private: true`, publishes nothing) that wires **every** `@liveflux/*`
package together and exercises each feature across realistic use-cases — at a developer/production
level. It is intentionally kept **out** of the default unit CI (`pnpm check` / `pnpm test`) so those
stay fast, and runs as a single command instead.

## Run it

```bash
pnpm e2e                 # from the repo root — builds the packages, then runs the suite
pnpm --filter e2e e2e    # same, skipping turbo (packages must already be built)
```

Under the hood it runs two Vitest projects (see `vitest.workspace.ts`):

- **node** — core / ws / phoenix integration + the cross-adapter conformance gate (real Node
  process, real in-process `ws` servers and Node WebSocket clients).
- **react** — the `@liveflux/react` bindings + the cross-package dashboard flow (jsdom).

## How the transports are faked (two levels, on purpose)

- **Real in-process servers** (`test/support/ws-server.ts`, `test/support/phoenix-server.ts`) — actual
  `ws` `WebSocketServer`s on ephemeral localhost ports. The `@liveflux/ws` / `@liveflux/phoenix`
  adapters connect to them through the Node `ws` client (injected as the `WebSocket` constructor), so
  every subscribe / broadcast / reconnect / heartbeat rides a genuine socket. The Phoenix server
  speaks the v2 tuple `[join_ref, ref, topic, event, payload]`: it replies `phx_reply {status:ok}` to
  `phx_join` (or `{status:error}` for topics registered via `rejectTopic`), acks the `phoenix`
  heartbeat, acknowledges `phx_leave`, broadcasts `[null,null,topic,event,payload]`, and can inject a
  `phx_error` on demand to drive the transparent-rejoin path. Both servers record per-connection
  history (connect query string, subscribes/joins, unsubscribes/leaves, heartbeats) so tests can
  assert reconnect replay and dynamic-token re-auth.
- **Controllable socket double** (`test/support/controllable-socket.ts`) — a synchronous, timer-free
  WebSocket stand-in that hands the *test* the server side (`open`/`emit`/`drop`/`error`). This is the
  deterministic Layer-1 transport the shared `runAdapterConformance` harness is built around; the
  adapters under it are entirely real.

Async round-trips use bounded polling (`test/support/async.ts` → `waitUntil`), never open-ended
sleeps, so the suite is fast and can never hang: a condition either holds within its timeout or the
test fails loudly.

## Coverage matrix

| Package | Feature | Use-case exercised | ✓ |
| --- | --- | --- | --- |
| **core** (via `MockAdapter`, fake timers) | store: append | accumulate in order; `cap` eviction; empty-before-first-event | ✓ |
| | store: upsert | idempotent by id, order preserved; function key + `cap` oldest-eviction | ✓ |
| | store: replace | latest snapshot; `undefined` before first event | ✓ |
| | store: reducer | custom fold into `S`; initial value | ✓ |
| | multiplex / ref-count | two identical subs share one wire sub + one fold; last-unsubscribe tears down; idempotent `destroy` | ✓ |
| | subscription identity | different params on same channel → one wire sub, independent folds; distinct channels → separate subs | ✓ |
| | reconnect | drop → backoff → reconnect → active sub replayed + resumes; give-up at `maxAttempts` → closed | ✓ |
| | `onConnectionChange` | idle→connecting→open→reconnecting→closed; throwing listener isolated (async re-throw asserted) | ✓ |
| | `onError` | adapter error reaches every listener; throwing listener isolated; unsubscribe stops delivery | ✓ |
| **ws** (real in-process `ws` server) | connect → subscribe → broadcast → unsubscribe | normalized event delivered; delivery stops after unsubscribe (ordering fence) | ✓ |
| | reconnect replay | server drop → client reconnects → server sees the re-subscribe → resumes receiving | ✓ |
| | subscribe-before-open | exactly one subscribe frame per subId on the wire | ✓ |
| | dynamic `url` re-auth | url function re-invoked on reconnect → refreshed token on the 2nd connect | ✓ |
| | heartbeat | keepalive frames observed on the server while open | ✓ |
| | custom `encode` / `decode` | control frames encoded via the seam; enriched envelope decoded to a NormalizedEvent (cursor preserved) | ✓ |
| | `maxMessageBytes` | oversized inbound frame dropped before decode; small frame still delivered | ✓ |
| **phoenix** (real in-process Phoenix v2 server) | join → broadcast → leave | join accepted, broadcast received, `phx_leave` sent on unsubscribe | ✓ |
| | reconnect re-join | server drop → active topics re-joined on the fresh connection → resumes | ✓ |
| | `phx_error` → transparent rejoin | server crashes the channel → client re-joins (same socket, backoff) → error surfaced + delivery resumes | ✓ |
| | dynamic `params` re-auth | params function re-invoked per connect → rotated token in the 2nd connect query (`vsn` present) | ✓ |
| | heartbeat round-trip | keepalives acked, dead-link guard never fires → single socket stays open | ✓ |
| | join-reply error | rejected join (`status:error`) surfaces as a `join_error` through `onError` | ✓ |
| **react** (jsdom + Testing Library, via `MockAdapter`) | `useStream` strategies | append / upsert / replace / reducer render and update on events | ✓ |
| | `useConnection` | reflects connection-state transitions (open → reconnecting) | ✓ |
| | selector + `isEqual` | no re-render when the selected slice is unchanged; recompute on a changed closed-over prop | ✓ |
| | param re-subscription | changing `params` on the same channel re-subscribes with a fresh fold | ✓ |
| | lifecycle | StrictMode double-mount → exactly one live wire sub; unmount cleans up; two components share one sub | ✓ |
| | SSR | `renderToString` via `getServerSnapshot` renders without throwing | ✓ |
| **cross-package** | dashboard flow (real ws) | Provider + two `useStream` panels on different channels + a `useConnection` pill; live events render; drop → recover | ✓ |
| **adapter-tests** | conformance gate | `runAdapterConformance` re-run against both real adapters (`ws` + `phoenix`) over the controllable socket — enforces cross-adapter parity | ✓ |

## Layout

```
apps/e2e/
  vitest.workspace.ts        # node + react (jsdom) projects
  test/
    support/
      async.ts               # bounded waits (waitUntil / waitForLength / deferred)
      ws-server.ts           # real @liveflux/ws control-protocol server
      phoenix-server.ts      # real Phoenix Channels v2 server
      controllable-socket.ts # synchronous socket double for the conformance gate
      node-ws.ts             # Node `ws` client typed as each adapter's WebSocket ctor
    node/
      core.test.ts           # A — core via MockAdapter
      ws.test.ts             # B — ws over a real server
      phoenix.test.ts        # C — phoenix over a real server
      conformance.test.ts    # F — cross-adapter conformance gate
    react/
      react.test.tsx         # D — react bindings
      dashboard.test.tsx     # E — cross-package smoke over a real ws server
```
