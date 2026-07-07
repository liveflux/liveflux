import { describe, expect, it, vi } from 'vitest';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '../types';
import { LivefluxClient } from './liveflux-client';

/** Adapter double that opens synchronously and lets tests push events. */
class MockAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connected = false;
  subscribed: string[] = [];
  unsubscribed: string[] = [];

  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    this.connected = true;
    handlers.onOpen();
  }
  disconnect(): void {
    this.connected = false;
  }
  subscribe(req: SubscribeRequest): void {
    this.subscribed.push(req.channel);
  }
  unsubscribe(subId: string): void {
    this.unsubscribed.push(subId);
  }

  emit(channel: string, payload: unknown): void {
    this.handlers?.onEvent({ channel, event: 'update', payload });
  }
}

describe('LivefluxClient', () => {
  it('connects the adapter and exposes connection state', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });

    expect(client.getConnectionState()).toBe('idle');
    client.connect();
    expect(client.getConnectionState()).toBe('open'); // MockAdapter opens synchronously
    expect(adapter.connected).toBe(true);
  });

  it('folds channel events into subscription state (append), ignoring other channels', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();

    const sub = client.subscribe<number>({ channel: 'trades', into: { strategy: 'append' } });
    expect(adapter.subscribed).toEqual(['trades']);
    expect(sub.getState()).toEqual([]);

    adapter.emit('trades', 1);
    adapter.emit('trades', 2);
    expect(sub.getState()).toEqual([1, 2]);

    adapter.emit('quotes', 9); // different channel — not folded in
    expect(sub.getState()).toEqual([1, 2]);
  });

  it('notifies subscription listeners when new events arrive', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();

    const sub = client.subscribe<number>({ channel: 'trades', into: { strategy: 'append' } });
    const onChange = vi.fn();
    sub.subscribe(onChange);

    adapter.emit('trades', 1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('sub.destroy() releases the wire subscription', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();

    const sub = client.subscribe({ channel: 'trades', into: { strategy: 'replace' } });
    sub.destroy();
    expect(adapter.unsubscribed).toHaveLength(1);
  });

  it('destroy() unsubscribes every channel and closes the connection', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    client.destroy();
    expect(adapter.unsubscribed).toHaveLength(1);
    expect(adapter.connected).toBe(false);
    expect(client.getConnectionState()).toBe('closed');
  });

  describe('subscription dedup (fold-sharing)', () => {
    it('shares one fold across identical subscriptions — folds once, reads many', () => {
      const adapter = new MockAdapter();
      const client = new LivefluxClient({ adapter });
      client.connect();

      const a = client.subscribe<number>({ channel: 'trades', into: { strategy: 'append' } });
      const b = client.subscribe<number>({ channel: 'trades', into: { strategy: 'append' } });

      // One wire subscription total (registry ref-counts) AND one shared store...
      expect(adapter.subscribed).toEqual(['trades']);
      adapter.emit('trades', 1);
      // ...so both handles observe the very same state reference (single fold, not two).
      expect(a.getState()).toEqual([1]);
      expect(b.getState()).toBe(a.getState());

      // A late subscriber joins the existing fold and sees the accumulated state.
      const c = client.subscribe<number>({ channel: 'trades', into: { strategy: 'append' } });
      expect(c.getState()).toBe(a.getState());
    });

    it('ref-counts: the wire is released only when the last identical subscriber leaves', () => {
      const adapter = new MockAdapter();
      const client = new LivefluxClient({ adapter });
      client.connect();

      const a = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
      const b = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

      a.destroy();
      expect(adapter.unsubscribed).toHaveLength(0); // b still holds the fold
      b.destroy();
      expect(adapter.unsubscribed).toHaveLength(1); // last one out tears down the wire
    });

    it('does NOT share function-based configs (reducer) — each gets its own fold', () => {
      const adapter = new MockAdapter();
      const client = new LivefluxClient({ adapter });
      client.connect();

      // A reducer carries functions → never keyed → each subscription gets a private store.
      const a = client.subscribe<number, number[]>({
        channel: 'n',
        into: { strategy: 'reducer', reduce: (arr, e) => [...arr, e.payload as number], initial: [] },
      });
      const b = client.subscribe<number, number[]>({
        channel: 'n',
        into: { strategy: 'reducer', reduce: (arr, e) => [...arr, e.payload as number], initial: [] },
      });

      adapter.emit('n', 1); // registry multiplexes the wire by channel, so both folds see the event
      expect(a.getState()).toEqual([1]);
      expect(b.getState()).toEqual([1]);
      expect(a.getState()).not.toBe(b.getState()); // ...but they are distinct stores (not shared)
    });

    it('does NOT share when params differ (distinct folds)', () => {
      const adapter = new MockAdapter();
      const client = new LivefluxClient({ adapter });
      client.connect();

      const a = client.subscribe<number>({
        channel: 'trades',
        into: { strategy: 'append' },
        params: { room: 1 },
      });
      const b = client.subscribe<number>({
        channel: 'trades',
        into: { strategy: 'append' },
        params: { room: 2 },
      });

      adapter.emit('trades', 1);
      expect(a.getState()).toEqual([1]);
      expect(a.getState()).not.toBe(b.getState()); // distinct params → distinct folds (separate stores)
    });
  });
});
