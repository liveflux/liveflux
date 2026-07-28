import { describe, expect, it } from 'vitest';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '../types';
import { LivefluxClient } from './liveflux-client';

class MockAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    handlers.onOpen();
  }
  disconnect(): void {}
  subscribe(_req: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}
}

describe('LivefluxClient.diagnose', () => {
  it('flags an idle connection and a missing subscription', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const report = client.diagnose('trades');
    expect(report).toMatchObject({
      channel: 'trades',
      connectionState: 'idle',
      subscribed: false,
      listenerCount: 0,
    });
    expect(report.hints.some((h) => h.includes('client.connect()'))).toBe(true);
    expect(report.hints.some((h) => h.includes('No active subscription'))).toBe(true);
  });

  it('reports a healthy channel when connected and subscribed', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    const report = client.diagnose('trades');
    expect(report).toMatchObject({ connectionState: 'open', subscribed: true, listenerCount: 1 });
    expect(report.hints.some((h) => h.includes('Subscribed and connected'))).toBe(true);
  });

  it('counts distinct folds on a channel (identical subs multiplex into one)', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    client.connect();
    // Two identical subscriptions share one fold → one wire listener.
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    expect(client.diagnose('trades').listenerCount).toBe(1);
    // A different strategy on the same channel is a second fold → a second wire listener.
    client.subscribe({ channel: 'trades', into: { strategy: 'replace' } });
    expect(client.diagnose('trades').listenerCount).toBe(2);
  });

  it('reports the wrong channel as unsubscribed', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    const report = client.diagnose('quotes');
    expect(report.subscribed).toBe(false);
    expect(report.hints.some((h) => h.includes('"quotes"'))).toBe(true);
  });
});
