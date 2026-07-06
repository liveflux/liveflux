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
});
