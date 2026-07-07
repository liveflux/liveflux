/**
 * Reconnection backoff — exponential growth with symmetric jitter.
 *
 * Kept as a pure module so the timing math is trivially unit-testable, independent of the ConnectionManager
 * that consumes it.
 */

/**
 * Policy controlling automatic reconnection. All fields required; merge from a Partial.
 * */
export interface ReconnectPolicy {
  /** Attempt to reconnect after an unexpected close. Default: true. */
  enabled: boolean;
  /** Delay before the first retry, in ms. Default: 500. */
  baseMs: number;
  /** Upper bound for any single delay, in ms. Default: 30_000. */
  maxMs: number;
  /** Exponential growth factor per attempt. Default: 2. */
  factor: number;
  /** Jitter fraction (0–1) applied ± to each delay to avoid thundering herds. Default: 0.5. */
  jitter: number;
  /** Give up after this many consecutive failed attempts. Default: Infinity. */
  maxAttempts: number;
}

/** Sensible, production-safe defaults. Frozen so shared state can't be mutated by a consumer. */
export const defaultReconnectPolicy: Readonly<ReconnectPolicy> = Object.freeze({
  enabled: true,
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.5,
  maxAttempts: Number.POSITIVE_INFINITY,
});

/** A finite number ≥ 0, or the fallback if the input is NaN/Infinity/negative/non-numeric. */
function safeNonNeg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Merge a user-supplied partial policy over the defaults, then clamp to safe invariants. A
 * malformed policy (negative/NaN delays, a shrinking `factor < 1`, out-of-range `jitter`) must
 * never be able to schedule a 0-, negative-, or NaN-delay reconnect storm against the server.
 */
export function resolveReconnectPolicy(policy?: Partial<ReconnectPolicy>): ReconnectPolicy {
  const p = { ...defaultReconnectPolicy, ...policy };
  const baseMs = safeNonNeg(p.baseMs, defaultReconnectPolicy.baseMs);
  return {
    enabled: p.enabled !== false, // any non-false → enabled (default true)
    baseMs,
    // Ceiling is always finite and never below the floor (keeps backoffDelay's fallback safe).
    maxMs: Math.max(baseMs, safeNonNeg(p.maxMs, defaultReconnectPolicy.maxMs)),
    // Backoff must never shrink: factor ≥ 1.
    factor: Math.max(1, safeNonNeg(p.factor, defaultReconnectPolicy.factor)),
    // Jitter is a fraction: clamp to [0, 1] so it can't drive a delay negative.
    jitter: Math.min(1, safeNonNeg(p.jitter, defaultReconnectPolicy.jitter)),
    // Infinity is valid (retry forever, the default); reject only NaN/negative.
    maxAttempts:
      typeof p.maxAttempts === 'number' && !Number.isNaN(p.maxAttempts) && p.maxAttempts >= 0
        ? p.maxAttempts
        : defaultReconnectPolicy.maxAttempts,
  };
}

/**
 * Delay (ms) to wait before a given reconnect attempt.
 * `attempt` is 1-based (1 = first retry). `rand` returns [0,1) and is injectable for
 * deterministic tests (defaults to Math.random).
 */
export function backoffDelay(
  attempt: number,
  policy: ReconnectPolicy,
  rand: () => number = Math.random,
): number {
  const raw = policy.baseMs * policy.factor ** (attempt - 1);
  const capped = Math.min(policy.maxMs, raw);
  const delta = capped * policy.jitter * (rand() * 2 - 1); // ± jitter fraction
  const delay = Math.round(capped + delta);
  // Defensive: a malformed policy (NaN/Infinity) must never schedule a 0/NaN-delay reconnect
  // storm. Fall back to the ceiling, which is always a safe, bounded wait.
  return Number.isFinite(delay) ? Math.max(0, delay) : policy.maxMs;
}
