/**
 * `@liveflux/adapter-tests/mock` — the {@link MockAdapter} alone, with **no test-runner code** pulled
 * in. The package root (`@liveflux/adapter-tests`) also re-exports `runAdapterConformance`, which
 * imports `vitest`; import from this subpath instead when you only need the programmable adapter (e.g.
 * driving `@liveflux/core` from a Node script, a Storybook story, or a non-Vitest test runner).
 */

export { MockAdapter } from './mock-adapter';
export type { ResumeCall } from './mock-adapter';
