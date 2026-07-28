import { describe, expect, it } from 'vitest';
import { buildRedactSet, redactValue } from './redact';

const keys = buildRedactSet();

describe('redactValue — edge cases', () => {
  it('redacts within the depth cap and stops recursing beyond it without throwing', () => {
    // Build a chain deeper than MAX_DEPTH (8).
    let deep: Record<string, unknown> = { token: 'leaf-secret' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => redactValue(deep, keys)).not.toThrow();

    // A token within the cap is still scrubbed.
    const shallow = { a: { b: { token: 'x' } } };
    const out = redactValue(shallow, keys) as { a: { b: { token: string } } };
    expect(out.a.b.token).toBe('«redacted»');
  });

  it('preserves a Date instead of flattening it to {}', () => {
    const date = new Date('2020-01-01T00:00:00Z');
    const out = redactValue({ when: date, token: 't' }, keys) as { when: unknown; token: string };
    expect(out.when).toBe(date); // preserved by reference, not mangled
    expect(out.token).toBe('«redacted»');
  });

  it('preserves a Map/Set rather than emptying them', () => {
    const map = new Map([['k', 'v']]);
    const set = new Set([1, 2]);
    const out = redactValue({ map, set }, keys) as { map: unknown; set: unknown };
    expect(out.map).toBe(map);
    expect(out.set).toBe(set);
  });

  it('preserves a class instance', () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    const p = new Point(1, 2);
    const out = redactValue({ p }, keys) as { p: unknown };
    expect(out.p).toBe(p);
  });

  it('handles arrays that contain a cycle', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    const out = redactValue(arr, keys) as unknown[];
    expect(out[0]).toBe(1);
    expect(out[1]).toBe('«circular»');
  });

  it('passes undefined through', () => {
    expect(redactValue(undefined, keys)).toBeUndefined();
  });

  it('creates a fresh clone (redacting does not alias the input object)', () => {
    const input = { a: 1, nested: { b: 2 } };
    const out = redactValue(input, keys) as { a: number; nested: object };
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });
});
