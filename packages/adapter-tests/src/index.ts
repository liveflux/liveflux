/**
 * @liveflux/adapter-tests — the Liveflux testing moat.
 *
 * Two tools, zero runtime dependencies:
 *   • {@link MockAdapter} — a programmable `StreamAdapter` with no real socket or timers, for
 *     driving `@liveflux/core` (and framework bindings) deterministically in unit tests.
 *   • {@link runAdapterConformance} — a shared, protocol-agnostic suite proving that any adapter
 *     honours the core `StreamAdapter` contract identically. Runs under the consumer's Vitest.
 *
 * Tree-shakeable: importing `MockAdapter` alone pulls in no test-runner code, so it adds nothing to
 * a production bundle.
 */

export { MockAdapter } from './mock-adapter';
export type { ResumeCall } from './mock-adapter';

export { runAdapterConformance } from './conformance';
export type {
  AdapterConformanceOptions,
  AdapterHarness,
  MaybePromise,
  ResumeFrame,
} from './conformance';
