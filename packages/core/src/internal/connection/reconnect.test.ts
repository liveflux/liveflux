import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  defaultReconnectPolicy,
  resolveReconnectPolicy,
  type ReconnectPolicy,
} from './reconnect';

const noJitter: ReconnectPolicy = { ...defaultReconnectPolicy, jitter: 0 };

describe('backoffDelay', () => {
  it('grows exponentially when jitter is off', () => {
    expect(backoffDelay(1, noJitter)).toBe(500);
    expect(backoffDelay(2, noJitter)).toBe(1000);
    expect(backoffDelay(3, noJitter)).toBe(2000);
    expect(backoffDelay(4, noJitter)).toBe(4000);
  });

  it('caps each delay at maxMs', () => {
    expect(backoffDelay(20, noJitter)).toBe(noJitter.maxMs);
  });

  it('applies symmetric jitter (± the jitter fraction)', () => {
    const p: ReconnectPolicy = { ...defaultReconnectPolicy, jitter: 0.5 };
    expect(backoffDelay(1, p, () => 1)).toBe(750); // +50%
    expect(backoffDelay(1, p, () => 0)).toBe(250); // -50%
    expect(backoffDelay(1, p, () => 0.5)).toBe(500); // no change
  });

  it('never returns a negative delay', () => {
    expect(
      backoffDelay(1, { ...defaultReconnectPolicy, jitter: 2 }, () => 0),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('resolveReconnectPolicy', () => {
  it('fills defaults and lets a partial override win', () => {
    expect(resolveReconnectPolicy()).toEqual(defaultReconnectPolicy);
    expect(resolveReconnectPolicy({ baseMs: 100 }).baseMs).toBe(100);
    expect(resolveReconnectPolicy({ baseMs: 100 }).maxMs).toBe(defaultReconnectPolicy.maxMs);
  });

  it('clamps a malformed policy to safe invariants (no storm/NaN)', () => {
    const p = resolveReconnectPolicy({
      baseMs: -100, // invalid → safe default (not 0, which would still storm)
      maxMs: Number.NaN, // NaN → default (never a NaN fallback)
      factor: 0.5, // shrinking → clamped to ≥ 1
      jitter: 5, // out of range → clamped to ≤ 1
      maxAttempts: -3, // negative → default
    });
    expect(p.baseMs).toBe(defaultReconnectPolicy.baseMs);
    expect(p.maxMs).toBe(defaultReconnectPolicy.maxMs);
    expect(p.factor).toBe(1);
    expect(p.jitter).toBe(1);
    expect(p.maxAttempts).toBe(defaultReconnectPolicy.maxAttempts);
  });

  it('raises maxMs to at least baseMs and keeps every delay finite & non-negative', () => {
    const p = resolveReconnectPolicy({ baseMs: 5000, maxMs: 100 }); // ceiling below floor
    expect(p.maxMs).toBe(5000);
    for (let attempt = 1; attempt <= 30; attempt++) {
      const d = backoffDelay(attempt, p, () => 0); // worst-case (max negative) jitter
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it('allows Infinity maxAttempts (retry forever) but rejects NaN', () => {
    expect(resolveReconnectPolicy({ maxAttempts: Infinity }).maxAttempts).toBe(Infinity);
    expect(resolveReconnectPolicy({ maxAttempts: Number.NaN }).maxAttempts).toBe(
      defaultReconnectPolicy.maxAttempts,
    );
  });
});
