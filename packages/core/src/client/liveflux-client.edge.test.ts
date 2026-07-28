import { describe, expect, it, vi } from 'vitest';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '../types';
import { LivefluxClient, type ClientObserver } from './liveflux-client';

/** Opens synchronously; lets tests push events. */
class MockAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    handlers.onOpen();
  }
  disconnect(): void {}
  subscribe(_req: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}
  emit(channel: string, payload: unknown): void {
    this.handlers?.onEvent({ channel, event: 'update', payload });
  }
}

/** Never opens — leaves the client in `connecting`. */
class PendingAdapter implements StreamAdapter {
  connect(_handlers: AdapterHandlers): void {}
  disconnect(): void {}
  subscribe(_req: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}
}

describe('observe — private folds (non-shareable configs)', () => {
  it('announces a reducer subscription (own fold) add + remove', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const add = vi.fn();
    const remove = vi.fn();
    client.observe({ onSubscriptionAdd: add, onSubscriptionRemove: remove });

    const sub = client.subscribe({
      channel: 'log',
      into: { strategy: 'reducer', reduce: (n: number) => n + 1, initial: 0 },
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({
      channel: 'log',
      strategy: 'reducer',
      refCount: 1,
    });

    sub.destroy();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('treats a function-key upsert as its own fold', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const add = vi.fn();
    client.observe({ onSubscriptionAdd: add });
    client.subscribe({
      channel: 'orders',
      into: { strategy: 'upsert', key: (o: { id: number }) => o.id },
    });
    expect(add.mock.calls[0]![0]).toMatchObject({ strategy: 'upsert', refCount: 1 });
  });
});

describe('observe — multiple observers & isolation', () => {
  it('fans events to every attached observer', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const a = vi.fn();
    const b = vi.fn();
    client.observe({ onEvent: a });
    client.observe({ onEvent: b });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', 1);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('isolates a throwing observer so siblings still run and the client survives', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const good = vi.fn();
    client.observe({
      onEvent: () => {
        throw new Error('bad observer');
      },
      onSubscriptionAdd: () => {
        throw new Error('bad add');
      },
    });
    client.observe({ onEvent: good });
    client.connect();
    const sub = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    expect(() => adapter.emit('trades', 1)).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
    expect(sub.getState()).toEqual([1]); // folding still worked
  });
});

describe('observe — ref-count sequences', () => {
  it('emits add, then a refchange per extra subscriber, then remove', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const add = vi.fn();
    const ref = vi.fn();
    const remove = vi.fn();
    client.observe({
      onSubscriptionAdd: add,
      onSubscriptionRefChange: ref,
      onSubscriptionRemove: remove,
    });

    const s1 = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    const s2 = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    const s3 = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    const id = add.mock.calls[0]![0].id as string;
    expect(add).toHaveBeenCalledTimes(1);
    expect(ref.mock.calls).toEqual([
      [id, 2],
      [id, 3],
    ]);

    s3.destroy();
    s2.destroy();
    expect(ref.mock.calls.slice(2)).toEqual([
      [id, 2],
      [id, 1],
    ]);
    expect(remove).not.toHaveBeenCalled();
    s1.destroy();
    expect(remove).toHaveBeenCalledWith(id);
  });

  it('a double destroy of one handle does not double-emit', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const remove = vi.fn();
    client.observe({ onSubscriptionRemove: remove });
    const sub = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    sub.destroy();
    sub.destroy();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('announces a fold that predated the observer on its next interaction', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    // Subscribe BEFORE any observer — fold exists, unannounced.
    const s1 = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    const add = vi.fn();
    const remove = vi.fn();
    client.observe({ onSubscriptionAdd: add, onSubscriptionRemove: remove });

    // Next interaction on the same key announces the (already ref=1) fold.
    const s2 = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ channel: 'trades', refCount: 2 });

    s1.destroy();
    s2.destroy();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('diagnose — connection-state edges', () => {
  it('reports a connecting adapter that has not opened', () => {
    const client = new LivefluxClient({ adapter: new PendingAdapter() });
    client.connect();
    const report = client.diagnose('trades');
    expect(report.connectionState).toBe('connecting');
    expect(report.hints.some((h) => h.includes('still opening'))).toBe(true);
  });

  it('reports a closed connection after destroy', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    client.connect();
    client.destroy();
    const report = client.diagnose('trades');
    expect(report.connectionState).toBe('closed');
    expect(report.hints.some((h) => h.toLowerCase().includes('closed'))).toBe(true);
  });

  it('flips subscribed back to false after the last unsubscribe', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    client.connect();
    const sub = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    expect(client.diagnose('trades').subscribed).toBe(true);
    sub.destroy();
    expect(client.diagnose('trades').subscribed).toBe(false);
  });
});
