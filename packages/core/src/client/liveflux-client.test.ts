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

  it('routes adapter events to the matching channel subscribers only', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();

    const listener = vi.fn();
    client.subscribe('trades', listener);
    expect(adapter.subscribed).toEqual(['trades']);

    adapter.emit('trades', { id: 1 });
    expect(listener).toHaveBeenCalledWith({
      channel: 'trades',
      event: 'update',
      payload: { id: 1 },
    });

    adapter.emit('quotes', { id: 2 }); // no subscriber on this channel
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('destroy() unsubscribes every channel and closes the connection', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    client.subscribe('trades', () => {});

    client.destroy();
    expect(adapter.unsubscribed).toHaveLength(1);
    expect(adapter.connected).toBe(false);
    expect(client.getConnectionState()).toBe('closed');
  });
});
