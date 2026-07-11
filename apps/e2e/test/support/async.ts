/**
 * Small async utilities shared by the real-socket integration tests. The socket round-trips are
 * genuinely asynchronous (a localhost TCP hop), so these give the tests *bounded, deterministic*
 * waits — never an open-ended `sleep`. A condition either becomes true within the timeout (the test
 * proceeds the instant it does) or the test fails loudly, so a regression can never hang CI.
 */

/** A promise plus its resolvers — handy for turning a one-shot callback into an awaitable. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Poll `predicate` until it returns true, resolving the moment it does. Rejects if the timeout
 * elapses first, surfacing an optional label so a failure names what never happened.
 */
export function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5, label = 'condition' }: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
  } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      let ok = false;
      try {
        ok = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`waitUntil timed out after ${timeoutMs}ms waiting for: ${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Resolve once `list` has reached (at least) `count` entries. */
export function waitForLength(
  list: { readonly length: number },
  count: number,
  label = 'length',
): Promise<void> {
  return waitUntil(() => list.length >= count, { label: `${label} >= ${count}` });
}
