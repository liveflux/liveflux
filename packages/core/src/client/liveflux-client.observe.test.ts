import { describe, expect, it, vi } from 'vitest';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '../types';
import { LivefluxClient, type ClientObserver } from './liveflux-client';

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
  fail(err: unknown): void {
    this.handlers?.onError(err);
  }
}

const recordingObserver = () => {
  const calls = {
    connection: [] as Array<[string, string]>,
    error: [] as unknown[],
    add: [] as Array<{ id: string; channel: string; strategy: string; refCount: number }>,
    ref: [] as Array<[string, number]>,
    remove: [] as string[],
    event: [] as Array<{ channel: string; payload: unknown }>,
  };
  const observer: ClientObserver = {
    onConnectionState: (state, previous) => calls.connection.push([state, previous]),
    onError: (err) => calls.error.push(err),
    onSubscriptionAdd: (sub) =>
      calls.add.push({
        id: sub.id,
        channel: sub.channel,
        strategy: sub.strategy,
        refCount: sub.refCount,
      }),
    onSubscriptionRefChange: (id, refCount) => calls.ref.push([id, refCount]),
    onSubscriptionRemove: (id) => calls.remove.push(id),
    onEvent: (e) => calls.event.push({ channel: e.channel, payload: e.payload }),
  };
  return { observer, calls };
};

describe('LivefluxClient.observe (the tap)', () => {
  it('works with no observer attached (zero-overhead default)', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    const sub = client.subscribe<number>({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', 1);
    expect(sub.getState()).toEqual([1]);
    expect(() => sub.destroy()).not.toThrow();
  });

  it('fans connection, subscription, event, and error lifecycle to the observer', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const { observer, calls } = recordingObserver();
    client.observe(observer);

    client.connect();
    expect(calls.connection.some(([state]) => state === 'open')).toBe(true);

    const a = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]).toMatchObject({ channel: 'trades', strategy: 'append', refCount: 1 });
    const subId = calls.add[0]!.id;

    const b = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    expect(calls.ref).toContainEqual([subId, 2]);

    adapter.emit('trades', { hello: 'world' });
    expect(calls.event).toContainEqual({ channel: 'trades', payload: { hello: 'world' } });

    adapter.fail(new Error('boom'));
    expect(calls.error).toHaveLength(1);

    a.destroy();
    expect(calls.ref).toContainEqual([subId, 1]);
    b.destroy();
    expect(calls.remove).toEqual([subId]);
  });

  it('passes the raw payload to onEvent (redaction is the tooling layer, not core)', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const { observer, calls } = recordingObserver();
    client.observe(observer);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    adapter.emit('trades', { token: 'secret' });
    expect(calls.event.at(-1)?.payload).toEqual({ token: 'secret' });
  });

  it('the returned unsubscribe fully detaches the observer', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const onEvent = vi.fn();
    const off = client.observe({ onEvent });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    off();
    adapter.emit('trades', 1);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
