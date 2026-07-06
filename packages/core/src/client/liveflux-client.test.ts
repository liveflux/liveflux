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
});
