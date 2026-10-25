import { describe, expect, it, vi } from 'vitest';
import type {
  AdapterHandlers,
  PublishRequest,
  ReplyFrame,
  RequestFrame,
  StreamAdapter,
  SubscribeRequest,
} from '../types';
import { RequestError, TimeoutError } from '../errors';
import {
  LivefluxClient,
  type ClientObserver,
  type ObservedPublish,
  type ObservedRequest,
  type ObservedRequestSettle,
} from './liveflux-client';

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

/** A publish/request-capable adapter that also lets a test deliver a correlated reply. */
class MockRpcAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  published: PublishRequest[] = [];
  requested: RequestFrame[] = [];
  autoOpen = true;
  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    if (this.autoOpen) handlers.onOpen();
  }
  disconnect(): void {}
  subscribe(_req: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}
  publish(req: PublishRequest): void {
    this.published.push(req);
  }
  request(req: RequestFrame): void {
    this.requested.push(req);
  }
  reply(reply: ReplyFrame): void {
    this.handlers?.onReply?.(reply);
  }
}

const commandObserver = () => {
  const calls = {
    publish: [] as ObservedPublish[],
    request: [] as ObservedRequest[],
    settle: [] as ObservedRequestSettle[],
  };
  const observer: ClientObserver = {
    onPublish: (c) => calls.publish.push(c),
    onRequest: (r) => calls.request.push(r),
    onRequestSettle: (s) => calls.settle.push(s),
  };
  return { observer, calls };
};

describe('LivefluxClient.observe — commands (publish / request)', () => {
  it('fires onPublish with the raw command info when open (queued: false)', () => {
    const adapter = new MockRpcAdapter();
    const client = new LivefluxClient({ adapter });
    const { observer, calls } = commandObserver();
    client.observe(observer);
    client.connect();

    client.publish('orders', 'create', { token: 'secret' }, { meta: { r: 1 }, idempotencyKey: 'k-1' });
    expect(calls.publish).toEqual([
      {
        channel: 'orders',
        event: 'create',
        payload: { token: 'secret' }, // raw — redaction is the tooling layer, not core
        meta: { r: 1 },
        idempotencyKey: 'k-1',
        queued: false,
      },
    ]);
    expect(adapter.published).toHaveLength(1); // actually sent
  });

  it('fires onPublish with queued: true when the outbox holds it (connection not open)', () => {
    const adapter = new MockRpcAdapter();
    const client = new LivefluxClient({ adapter, offline: { maxSize: 10 } });
    const { observer, calls } = commandObserver();
    client.observe(observer);
    // not connected → state is not open → the command is queued, not sent
    client.publish('orders', 'create', 1);
    expect(calls.publish).toEqual([{ channel: 'orders', event: 'create', payload: 1, queued: true }]);
    expect(adapter.published).toHaveLength(0); // held in the outbox, not sent
  });

  it('fires onRequest then onRequestSettle(resolved) on a successful reply', async () => {
    const adapter = new MockRpcAdapter();
    const client = new LivefluxClient({ adapter });
    const { observer, calls } = commandObserver();
    client.observe(observer);
    client.connect();

    const p = client.request('orders', 'create', { sku: 'A1' }, { meta: { r: 1 } });
    expect(calls.request).toEqual([
      { requestId: 'req-1', channel: 'orders', event: 'create', payload: { sku: 'A1' }, meta: { r: 1 }, queued: false },
    ]);
    expect(calls.settle).toHaveLength(0); // still pending

    adapter.reply({ requestId: 'req-1', ok: true, payload: { id: 7 } });
    await expect(p).resolves.toEqual({ id: 7 });
    expect(calls.settle).toEqual([{ requestId: 'req-1', outcome: 'resolved', payload: { id: 7 } }]);
  });

  it('fires onRequestSettle(rejected) when the server rejects the reply', async () => {
    const adapter = new MockRpcAdapter();
    const client = new LivefluxClient({ adapter });
    const { observer, calls } = commandObserver();
    client.observe(observer);
    client.connect();

    const p = client.request('orders', 'create', {});
    adapter.reply({ requestId: 'req-1', ok: false, error: { message: 'nope', code: 'BAD' } });
    await expect(p).rejects.toBeInstanceOf(RequestError);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]).toMatchObject({ requestId: 'req-1', outcome: 'rejected' });
    expect(calls.settle[0]!.error).toBeInstanceOf(RequestError);
  });

  it('fires onRequestSettle(rejected) exactly once on timeout', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockRpcAdapter();
      const client = new LivefluxClient({ adapter });
      const { observer, calls } = commandObserver();
      client.observe(observer);
      client.connect();

      const p = client.request('orders', 'create', {}, { timeoutMs: 1000 });
      p.catch(() => {}); // swallow — asserted below
      vi.advanceTimersByTime(1000);
      // a late reply after the timeout must NOT produce a second settle
      adapter.reply({ requestId: 'req-1', ok: true, payload: 'late' });

      await expect(p).rejects.toBeInstanceOf(TimeoutError);
      expect(calls.settle).toHaveLength(1);
      expect(calls.settle[0]).toMatchObject({ requestId: 'req-1', outcome: 'rejected' });
      expect(calls.settle[0]!.error).toBeInstanceOf(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});
