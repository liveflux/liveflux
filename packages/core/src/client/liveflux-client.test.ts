import { describe, expect, it, vi } from 'vitest';
import type {
  AdapterHandlers,
  PublishRequest,
  ReplyFrame,
  RequestFrame,
  StreamAdapter,
  SubscribeRequest,
} from '../types';
import { BackpressureError, ConnectionError, RequestError, TimeoutError } from '../errors';
import { LivefluxClient } from './liveflux-client';

/** Adapter double that opens synchronously and lets tests push events. */
class MockAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connected = false;
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  published: PublishRequest[] = [];

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
  publish(req: PublishRequest): void {
    this.published.push(req);
  }
  requested: RequestFrame[] = [];
  request(req: RequestFrame): void {
    this.requested.push(req);
  }

  emit(channel: string, payload: unknown): void {
    this.handlers?.onEvent({ channel, event: 'update', payload });
  }
  /** Play the server: deliver a reply for a prior request. */
  reply(frame: ReplyFrame): void {
    this.handlers?.onReply?.(frame);
  }
  /** Play the server: drop the live connection. */
  drop(): void {
    this.handlers?.onClose();
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

describe('LivefluxClient — publish (client→server)', () => {
  it('forwards a fire-and-forget command to the adapter when the connection is open', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    client.publish('orders', 'create', { sku: 'A1', qty: 2 }, { meta: { reqId: 'x' } });
    expect(adapter.published).toEqual([
      { channel: 'orders', event: 'create', payload: { sku: 'A1', qty: 2 }, meta: { reqId: 'x' } },
    ]);
  });

  it('throws a ConnectionError when the connection is not open', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    // never connected → state is 'idle'
    expect(() => client.publish('orders', 'create', {})).toThrow(ConnectionError);
    expect(adapter.published).toHaveLength(0);
  });

  it('throws a ConnectionError when the transport has no publish capability', () => {
    // a minimal adapter that opens but omits the optional publish capability
    const adapter: StreamAdapter = {
      connect: (h) => h.onOpen(),
      disconnect: () => {},
      subscribe: () => {},
      unsubscribe: () => {},
    };
    const client = new LivefluxClient({ adapter });
    client.connect();
    expect(() => client.publish('orders', 'create', {})).toThrow(ConnectionError);
  });
});

describe('LivefluxClient — request (client→server RPC)', () => {
  it('resolves with the server payload on a matching ok reply', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    const p = client.request<{ id: number }>('orders', 'create', { sku: 'A1' });
    const sent = adapter.requested.at(-1)!;
    expect(sent).toMatchObject({ channel: 'orders', event: 'create', payload: { sku: 'A1' } });
    adapter.reply({ requestId: sent.requestId, ok: true, payload: { id: 7 } });
    await expect(p).resolves.toEqual({ id: 7 });
  });

  it('rejects with a RequestError on an ok:false reply (carrying server code/data)', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    const p = client.request('orders', 'create', {});
    const id = adapter.requested.at(-1)!.requestId;
    adapter.reply({ requestId: id, ok: false, error: { message: 'out of stock', code: 'OOS', data: { sku: 'A1' } } });
    await expect(p).rejects.toBeInstanceOf(RequestError);
    await p.catch((e: RequestError) => {
      expect(e.message).toBe('out of stock');
      expect(e.serverCode).toBe('OOS');
      expect(e.data).toEqual({ sku: 'A1' });
    });
  });

  it('rejects with a TimeoutError when no reply arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockAdapter();
      const client = new LivefluxClient({ adapter, requestTimeoutMs: 1000 });
      client.connect();
      const p = client.request('orders', 'create', {});
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with a ConnectionError when the connection is not open', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    await expect(client.request('orders', 'create', {})).rejects.toBeInstanceOf(ConnectionError);
  });

  it('rejects in-flight requests with a ConnectionError when the connection drops', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    const p = client.request('orders', 'create', {});
    adapter.drop(); // server drops the link → core rejects the pending request
    await expect(p).rejects.toBeInstanceOf(ConnectionError);
  });

  it('rejects when aborted via an AbortSignal, and ignores a late reply', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    const ac = new AbortController();
    const p = client.request('orders', 'create', {}, { signal: ac.signal });
    const id = adapter.requested.at(-1)!.requestId;
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    // a reply that arrives after abort must be a harmless no-op (already settled + untracked)
    expect(() => adapter.reply({ requestId: id, ok: true, payload: 1 })).not.toThrow();
  });
});

describe('LivefluxClient — offline outbox (opt-in)', () => {
  it('queues a publish while closed and flushes it (FIFO) on open', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter, offline: {} });
    // not connected yet → state is 'idle' (not open)
    client.publish('orders', 'a', 1);
    client.publish('orders', 'b', 2);
    expect(adapter.published).toHaveLength(0); // queued, not sent
    client.connect(); // → open → flush in order
    expect(adapter.published.map((p) => p.event)).toEqual(['a', 'b']);
  });

  it('queues a request while closed, sends it on open, and resolves on the reply', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter, offline: {} });
    const p = client.request<number>('orders', 'create', {});
    expect(adapter.requested).toHaveLength(0); // queued
    client.connect(); // → open → flush → sent
    expect(adapter.requested).toHaveLength(1);
    adapter.reply({ requestId: adapter.requested[0]!.requestId, ok: true, payload: 42 });
    await expect(p).resolves.toBe(42);
  });

  it('drops the oldest when the outbox is full, rejecting that dropped request', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter, offline: { maxSize: 2 } });
    const p1 = client.request('c', 'e', 1);
    const p2 = client.request('c', 'e', 2);
    const p3 = client.request('c', 'e', 3); // overflow → evicts the oldest (p1)
    await expect(p1).rejects.toBeInstanceOf(ConnectionError);
    client.connect();
    expect(adapter.requested).toHaveLength(2); // p2, p3 survived
    for (const r of adapter.requested) adapter.reply({ requestId: r.requestId, ok: true, payload: 0 });
    await Promise.all([p2, p3]);
  });

  it('drops a queued entry that outlived the TTL, rejecting the request with a TimeoutError', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockAdapter();
      const client = new LivefluxClient({ adapter, offline: { ttlMs: 1000 }, requestTimeoutMs: 60_000 });
      const p = client.request('c', 'e', 1); // queued at t=0
      vi.advanceTimersByTime(2000); // wait past the TTL
      client.connect(); // flush → entry is stale → dropped
      await expect(p).rejects.toBeInstanceOf(TimeoutError);
      expect(adapter.requested).toHaveLength(0); // never sent
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops queued entries on destroy(), rejecting queued requests', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter, offline: {} });
    const p = client.request('c', 'e', 1); // queued
    client.destroy();
    await expect(p).rejects.toBeInstanceOf(ConnectionError);
  });

  it('removes a queued request from the outbox when aborted', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter, offline: {} });
    const ac = new AbortController();
    const p = client.request('c', 'e', 1, { signal: ac.signal }); // queued
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    client.connect();
    expect(adapter.requested).toHaveLength(0); // aborted entry was removed, nothing flushed
  });

  it('without the outbox, a publish/request while closed still fails fast', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter }); // no offline config
    expect(() => client.publish('c', 'e', 1)).toThrow(ConnectionError);
    await expect(client.request('c', 'e', 1)).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe('LivefluxClient — backpressure (in-flight cap)', () => {
  it('rejects with BackpressureError when the cap is exceeded, leaving earlier requests intact', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter, maxInFlightRequests: 1 });
    client.connect();
    const p1 = client.request<number>('c', 'e', 1); // in flight (1/1)
    const p2 = client.request('c', 'e', 2); // would exceed the cap → refused
    await expect(p2).rejects.toBeInstanceOf(BackpressureError);
    expect(adapter.requested).toHaveLength(1); // only p1 hit the wire
    adapter.reply({ requestId: adapter.requested[0]!.requestId, ok: true, payload: 9 });
    await expect(p1).resolves.toBe(9);
  });
});

describe('LivefluxClient — idempotency key', () => {
  it('carries an idempotencyKey on the publish and request frames', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    client.publish('c', 'e', 1, { idempotencyKey: 'k1' });
    expect(adapter.published.at(-1)).toMatchObject({ idempotencyKey: 'k1' });

    const p = client.request('c', 'e', 2, { idempotencyKey: 'k2' });
    const sent = adapter.requested.at(-1)!;
    expect(sent).toMatchObject({ idempotencyKey: 'k2' });
    adapter.reply({ requestId: sent.requestId, ok: true, payload: 0 });
    await p;
  });
});
