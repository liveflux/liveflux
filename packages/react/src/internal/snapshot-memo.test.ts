import { describe, expect, it, vi } from 'vitest';
import { SnapshotMemo } from './snapshot-memo';

describe('SnapshotMemo', () => {
  it('caches by raw-input identity — does not re-run select for the same input', () => {
    const memo = new SnapshotMemo<number>();
    const raw = [1, 2, 3];
    const select = vi.fn((r: unknown) => (r as number[]).length);
    expect(memo.read(raw, select, Object.is)).toBe(3);
    expect(memo.read(raw, select, Object.is)).toBe(3); // same reference → cached
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the raw input changes', () => {
    const memo = new SnapshotMemo<number>();
    const select = (r: unknown) => (r as number[]).length;
    expect(memo.read([1], select, Object.is)).toBe(1);
    expect(memo.read([1, 2], select, Object.is)).toBe(2);
  });

  it('keeps the previous reference when the selected value is isEqual', () => {
    const memo = new SnapshotMemo<{ n: number }>();
    const select = (r: unknown) => ({ n: (r as number[]).length });
    const shallow = (a: { n: number }, b: { n: number }) => a.n === b.n;
    const first = memo.read([1, 2], select, shallow);
    const second = memo.read([9, 9], select, shallow); // different raw, same length → same n
    expect(second).toBe(first); // stable ref so React skips the re-render
  });

  it('passes the raw input through unchanged when there is no selector', () => {
    const memo = new SnapshotMemo<number[]>();
    const raw = [1, 2];
    expect(memo.read(raw, undefined, Object.is)).toBe(raw);
  });
});
