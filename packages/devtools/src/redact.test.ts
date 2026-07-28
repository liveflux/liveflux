import { describe, expect, it } from 'vitest';
import { buildRedactSet, DEFAULT_REDACT_KEYS, redactValue } from './redact';

const keys = buildRedactSet();

describe('buildRedactSet', () => {
  it('lowercases defaults and merges extras', () => {
    const set = buildRedactSet(['X-Custom', 'sessionId']);
    expect(set.has('authorization')).toBe(true);
    expect(set.has('x-custom')).toBe(true);
    expect(set.has('sessionid')).toBe(true);
  });

  it('covers the common credential carriers', () => {
    for (const k of DEFAULT_REDACT_KEYS) expect(keys.has(k)).toBe(true);
  });
});

describe('redactValue', () => {
  it('scrubs matching keys case-insensitively', () => {
    const out = redactValue({ Authorization: 'Bearer x', token: 'abc', price: 10 }, keys) as Record<
      string,
      unknown
    >;
    expect(out.Authorization).toBe('«redacted»');
    expect(out.token).toBe('«redacted»');
    expect(out.price).toBe(10);
  });

  it('scrubs nested objects and arrays', () => {
    const out = redactValue(
      { user: { password: 'p', name: 'ann' }, list: [{ apikey: 'k' }] },
      keys,
    ) as { user: Record<string, unknown>; list: Record<string, unknown>[] };
    expect(out.user.password).toBe('«redacted»');
    expect(out.user.name).toBe('ann');
    expect(out.list[0]!.apikey).toBe('«redacted»');
  });

  it('passes primitives through unchanged', () => {
    expect(redactValue(42, keys)).toBe(42);
    expect(redactValue('hi', keys)).toBe('hi');
    expect(redactValue(null, keys)).toBe(null);
  });

  it('never mutates the input (the store keeps the original)', () => {
    const input = { token: 'secret', nested: { password: 'p' } };
    redactValue(input, keys);
    expect(input.token).toBe('secret');
    expect(input.nested.password).toBe('p');
  });

  it('guards against cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redactValue(a, keys) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('«circular»');
  });

  it('with a custom key set, scrubs custom keys too', () => {
    const custom = buildRedactSet(['ssn']);
    const out = redactValue({ ssn: '123', ok: 1 }, custom) as Record<string, unknown>;
    expect(out.ssn).toBe('«redacted»');
    expect(out.ok).toBe(1);
  });
});
