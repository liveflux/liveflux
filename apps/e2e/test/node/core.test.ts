import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { ConnectionState, NormalizedEvent } from '@liveflux/core';
import { MockAdapter } from '@liveflux/adapter-tests';

/**
 * Layer-1 core integration — the whole `@liveflux/core` engine (connection lifecycle, subscription
 * registry, and every store strategy) driven through the public `LivefluxClient` against the
 * programmable `MockAdapter`. Fully deterministic: no real socket, and fake timers own every
 * backoff so reconnection timing is asserted, not slept through.
 */

/** Push one event down the mock wire on `channel`. */
function emit(adapter: MockAdapter, channel: string, payload: unknown, extra?: Partial<NormalizedEvent>): void {
  adapter.emit({ channel, event: 'update', payload, ...extra });
}

describe('core · store strategies (folded through LivefluxClient)', () => {
  let adapter: MockAdapter;
  let client: LivefluxClient;

  beforeEach(() => {
    adapter = new MockAdapter();
    client = new LivefluxClient({ adapter });
    client.connect();
    adapter.open();
  });

  afterEach(() => {
    client.destroy();
  });

  it('append accumulates every event in arrival order', () => {
    const sub = client.subscribe<number>({ channel: 'feed', into: { strategy: 'append' } });
    expect(sub.getState()).toEqual([]); // empty before the first event
    emit(adapter, 'feed', 1);
    emit(adapter, 'feed', 2);
    emit(adapter, 'feed', 3);
    expect(sub.getState()).toEqual([1, 2, 3]);
    sub.destroy();
  });

  it('append with cap keeps only the last N (eviction)', () => {
    const sub = client.subscribe<number>({ channel: 'feed', into: { strategy: 'append', cap: 2 } });
    for (const n of [1, 2, 3, 4]) emit(adapter, 'feed', n);
    expect(sub.getState()).toEqual([3, 4]);
    sub.destroy();
  });

  it('upsert is idempotent by id and preserves insertion order', () => {
    interface Row {
      id: number;
      v: string;
    }
    const sub = client.subscribe<Row>({ channel: 'rows', into: { strategy: 'upsert', key: 'id' } });
    emit(adapter, 'rows', { id: 1, v: 'a' });
    emit(adapter, 'rows', { id: 2, v: 'b' });
    emit(adapter, 'rows', { id: 1, v: 'a2' }); // update in place — no new slot, order kept
    expect(sub.getState()).toEqual([
      { id: 1, v: 'a2' },
      { id: 2, v: 'b' },
    ]);
    sub.destroy();
  });

  it('upsert with a function key and cap evicts the oldest entity', () => {
    interface Row {
      key: string;
      n: number;
    }
    const sub = client.subscribe<Row>({
      channel: 'rows',
      into: { strategy: 'upsert', key: (r) => r.key, cap: 2 },
    });
    emit(adapter, 'rows', { key: 'a', n: 1 });
    emit(adapter, 'rows', { key: 'b', n: 2 });
    emit(adapter, 'rows', { key: 'c', n: 3 }); // evicts 'a' (oldest)
    expect(sub.getState()).toEqual([
      { key: 'b', n: 2 },
      { key: 'c', n: 3 },
    ]);
    sub.destroy();
  });

  it('replace keeps only the latest snapshot (undefined before the first event)', () => {
    const sub = client.subscribe<{ price: number }>({
      channel: 'ticker',
      into: { strategy: 'replace' },
    });
    expect(sub.getState()).toBeUndefined();
    emit(adapter, 'ticker', { price: 100 });
    emit(adapter, 'ticker', { price: 101 });
    expect(sub.getState()).toEqual({ price: 101 });
    sub.destroy();
  });

  it('reducer folds events into custom state via the supplied reducer', () => {
    const sub = client.subscribe<number, number>({
      channel: 'counter',
      into: {
        strategy: 'reducer',
        initial: 0,
        reduce: (total, event) => total + (event.payload as number),
      },
    });
    expect(sub.getState()).toBe(0);
    emit(adapter, 'counter', 5);
    emit(adapter, 'counter', 7);
    expect(sub.getState()).toBe(12);
    sub.destroy();
  });
});

describe('core · multiplex + ref-count', () => {
  let adapter: MockAdapter;
  let client: LivefluxClient;

  beforeEach(() => {
    adapter = new MockAdapter();
    client = new LivefluxClient({ adapter });
    client.connect();
    adapter.open();
  });
  afterEach(() => client.destroy());

  it('two identical subscriptions share one wire sub and one fold', () => {
    const a = client.subscribe<number>({ channel: 'feed', into: { strategy: 'append' } });
    const b = client.subscribe<number>({ channel: 'feed', into: { strategy: 'append' } });
    // Exactly one subscribe frame on the wire despite two subscribers.
    expect(adapter.subscriptions).toHaveLength(1);

    emit(adapter, 'feed', 1);
    // Shared fold: both handles read the identical (same-reference) state.
    expect(a.getState()).toEqual([1]);
    expect(b.getState()).toBe(a.getState());

    // Last-unsubscribe tears the wire sub down.
    a.destroy();
    expect(adapter.subscriptions).toHaveLength(1); // b still holds it
    b.destroy();
    expect(adapter.subscriptions).toHaveLength(0);
    expect(adapter.unsubscribeLog).toHaveLength(1);
  });

  it('different params on the same channel share one wire sub but keep independent folds', () => {
    // The registry multiplexes by channel, so a single wire subscription is opened; the client keys
    // its folds by channel + params + strategy, so the two configs get separate stores.
    const a = client.subscribe<number>({
      channel: 'feed',
      into: { strategy: 'append' },
      params: { room: 1 },
    });
    const b = client.subscribe<number>({
      channel: 'feed',
      into: { strategy: 'append' },
      params: { room: 2 },
    });
    expect(adapter.subscriptions).toHaveLength(1); // one wire sub (multiplexed by channel)

    emit(adapter, 'feed', 1);
    expect(a.getState()).toEqual([1]);
    expect(b.getState()).toEqual([1]);
    expect(a.getState()).not.toBe(b.getState()); // separate folds — distinct references
    a.destroy();
    b.destroy();
  });

  it('opens separate wire subs for genuinely distinct channels', () => {
    client.subscribe<number>({ channel: 'feed:1', into: { strategy: 'append' } });
    client.subscribe<number>({ channel: 'feed:2', into: { strategy: 'append' } });
    expect(adapter.subscriptions).toHaveLength(2);
  });

  it('destroy is idempotent per handle — a double destroy never over-releases the shared fold', () => {
    const a = client.subscribe<number>({ channel: 'feed', into: { strategy: 'append' } });
    const b = client.subscribe<number>({ channel: 'feed', into: { strategy: 'append' } });
    a.destroy();
    a.destroy(); // must NOT decrement the shared ref a second time
    expect(adapter.subscriptions).toHaveLength(1); // b still alive
    b.destroy();
    expect(adapter.subscriptions).toHaveLength(0);
  });
});

describe('core · reconnect replay (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops, backs off, reconnects, and the active sub keeps receiving', () => {
    const adapter = new MockAdapter();
    // Deterministic backoff: no jitter so the delay is exact.
    const client = new LivefluxClient({ adapter, reconnect: { baseMs: 100, jitter: 0 } });
    const states: ConnectionState[] = [];
    client.onConnectionChange((s) => states.push(s));
    client.connect();
    adapter.open();

    const sub = client.subscribe<number>({ channel: 'feed', into: { strategy: 'append' } });
    emit(adapter, 'feed', 1);
    expect(sub.getState()).toEqual([1]);

    adapter.drop('network-loss'); // unexpected close → schedules a reconnect
    expect(client.getConnectionState()).toBe('reconnecting');

    vi.advanceTimersByTime(100); // fire the backoff timer → connect() again
    adapter.open(); // the adapter replays its active set on (re)open
    expect(client.getConnectionState()).toBe('open');

    emit(adapter, 'feed', 2); // resumes after reconnect
    expect(sub.getState()).toEqual([1, 2]);

    // The active sub was replayed on the wire (once) after the drop.
    expect(adapter.subscribeLog.filter((s) => s.channel === 'feed')).toHaveLength(2);
    expect(states).toContain('reconnecting');
    client.destroy();
  });

  it('gives up after maxAttempts and lands in closed', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({
      adapter,
      reconnect: { baseMs: 50, jitter: 0, maxAttempts: 2 },
    });
    client.connect();
    adapter.open();

    adapter.drop(); // attempt 1 scheduled
    vi.advanceTimersByTime(50);
    adapter.drop(); // attempt 2 scheduled (open() never called → connect fails again)
    vi.advanceTimersByTime(100);
    adapter.drop(); // exceeds maxAttempts → closed
    expect(client.getConnectionState()).toBe('closed');
    client.destroy();
  });
});

describe('core · connection-state transitions', () => {
  it('walks idle → connecting → open → reconnecting → closed', () => {
    vi.useFakeTimers();
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter, reconnect: { baseMs: 10, jitter: 0 } });
    const seen: ConnectionState[] = [];
    client.onConnectionChange((state) => seen.push(state));

    expect(client.getConnectionState()).toBe('idle');
    client.connect();
    expect(client.getConnectionState()).toBe('connecting');
    adapter.open();
    expect(client.getConnectionState()).toBe('open');
    adapter.drop();
    expect(client.getConnectionState()).toBe('reconnecting');
    client.destroy(); // explicit teardown → closed

    expect(seen).toEqual(['connecting', 'open', 'reconnecting', 'closed']);
    vi.useRealTimers();
  });

  it('isolates a throwing state listener — the others and the state machine survive', () => {
    // Capture the intentional async re-throw so it is asserted, not leaked as an uncaught exception.
    const microtasks: Array<() => void> = [];
    const mt = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => {
      microtasks.push(cb);
    });
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const good: ConnectionState[] = [];
    client.onConnectionChange(() => {
      throw new Error('bad listener');
    });
    client.onConnectionChange((s) => good.push(s));
    client.connect();
    adapter.open();
    expect(good).toEqual(['connecting', 'open']); // second listener unaffected
    expect(client.getConnectionState()).toBe('open');
    // The bad listener's error is resurfaced asynchronously (once per transition), never swallowed.
    expect(microtasks).toHaveLength(2);
    expect(() => microtasks[0]?.()).toThrow('bad listener');
    client.destroy();
    mt.mockRestore();
  });
});

describe('core · onError surfacing', () => {
  it('routes an adapter error to every onError listener, isolating a throwing one', () => {
    const microtasks: Array<() => void> = [];
    const mt = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => {
      microtasks.push(cb);
    });
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    client.onError(() => {
      throw new Error('listener A throws');
    });
    client.onError((e) => seenA.push(e));
    const off = client.onError((e) => seenB.push(e));
    client.connect();
    adapter.open();

    const boom = new Error('transport-boom');
    adapter.fail(boom);
    expect(seenA).toEqual([boom]); // healthy listeners still received it despite A throwing
    expect(seenB).toEqual([boom]);
    // A's throw is resurfaced asynchronously, never swallowed.
    expect(microtasks).toHaveLength(1);
    expect(() => microtasks[0]?.()).toThrow('listener A throws');

    off(); // unsubscribed listeners stop receiving
    adapter.fail(new Error('second'));
    expect(seenB).toHaveLength(1);
    client.destroy();
    mt.mockRestore();
  });
});
