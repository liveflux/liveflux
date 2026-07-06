import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '../../types';
import { Store } from './store';

const evt = (payload: unknown): NormalizedEvent => ({ channel: 'c', event: 'update', payload });

describe('Store', () => {
  it('append accumulates payloads into a list', () => {
    const store = new Store<number>({ strategy: 'append' });
    store.apply(evt(1));
    store.apply(evt(2));
    expect(store.getState()).toEqual([1, 2]);
  });

  it('append respects cap (keeps the most recent)', () => {
    const store = new Store<number>({ strategy: 'append', cap: 2 });
    store.apply(evt(1));
    store.apply(evt(2));
    store.apply(evt(3));
    expect(store.getState()).toEqual([2, 3]);
  });

  it('upsert replaces by key and appends new keys', () => {
    type Row = { id: number; v: string };
    const store = new Store<Row>({ strategy: 'upsert', key: 'id' });
    store.apply(evt({ id: 1, v: 'a' }));
    store.apply(evt({ id: 2, v: 'b' }));
    store.apply(evt({ id: 1, v: 'a2' }));
    expect(store.getState()).toEqual([
      { id: 1, v: 'a2' },
      { id: 2, v: 'b' },
    ]);
  });

  it('upsert supports a key function and cap (index rebuilt after trim)', () => {
    type Row = { id: number };
    const store = new Store<Row>({ strategy: 'upsert', key: (r) => r.id, cap: 2 });
    store.apply(evt({ id: 1 }));
    store.apply(evt({ id: 2 }));
    store.apply(evt({ id: 3 })); // trims id 1 → [{2},{3}]
    store.apply(evt({ id: 2 })); // still replaces id 2
    expect(store.getState()).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it('replace keeps only the latest payload', () => {
    const store = new Store<{ n: number }>({ strategy: 'replace' });
    expect(store.getState()).toBeUndefined();
    store.apply(evt({ n: 1 }));
    store.apply(evt({ n: 2 }));
    expect(store.getState()).toEqual({ n: 2 });
  });

  it('reducer folds events with an initial state', () => {
    const store = new Store<unknown, number>({
      strategy: 'reducer',
      initial: 0,
      reduce: (count) => count + 1,
    });
    expect(store.getState()).toBe(0);
    store.apply(evt('x'));
    store.apply(evt('y'));
    expect(store.getState()).toBe(2);
  });

  it('notifies subscribers on change, and stops after unsubscribe', () => {
    const store = new Store<number>({ strategy: 'append' });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.apply(evt(1));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.apply(evt(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
