import { describe, expect, it } from 'vitest';
import type { AdapterHandlers, NormalizedEvent } from '@liveflux/core';
import { socketio, type SocketLike } from './index';

class FakeSocket implements SocketLike {
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly outbound: { event: string; args: unknown[] }[] = [];
  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): this {
    this.outbound.push({ event, args });
    return this;
  }
  connect(): this {
    this.connectCalls += 1;
    return this;
  }
  disconnect(): this {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args);
  }
  serverConnect(): void {
    this.connected = true;
    this.fire('connect');
  }
}

function recorder(): AdapterHandlers & {
  opens: number;
  closes: number;
  errors: unknown[];
  events: NormalizedEvent[];
  replies: unknown[];
} {
  const rec = {
    opens: 0,
    closes: 0,
    errors: [] as unknown[],
    events: [] as NormalizedEvent[],
    replies: [] as unknown[],
    onOpen() {
      rec.opens += 1;
    },
    onClose() {
      rec.closes += 1;
    },
    onError(e: unknown) {
      rec.errors.push(e);
    },
    onEvent(ev: NormalizedEvent) {
      rec.events.push(ev);
    },
    onReply(reply: unknown) {
      rec.replies.push(reply);
    },
  };
  return rec;
}

describe('@liveflux/socketio', () => {
  it('opens immediately when the socket is already connected (no connect() call)', () => {
    const socket = new FakeSocket();
    socket.connected = true;
    const adapter = socketio(socket);
    const rec = recorder();
    adapter.connect(rec);
    expect(rec.opens).toBe(1);
    expect(socket.connectCalls).toBe(0); // already live → don't re-connect
  });

  it('emits subscribe once connected and delivers inbound events', () => {
    const socket = new FakeSocket();
    const adapter = socketio(socket);
    const rec = recorder();
    adapter.connect(rec);
    expect(socket.connectCalls).toBe(1); // not connected → started connecting
    socket.serverConnect();
    adapter.subscribe({ subId: 's1', channel: 'orders', params: { x: 1 } });
    expect(socket.outbound).toContainEqual({
      event: 'subscribe',
      args: [{ subId: 's1', channel: 'orders', params: { x: 1 } }],
    });
    socket.fire('message', { channel: 'orders', event: 'update', payload: 7 });
    expect(rec.events).toEqual([{ channel: 'orders', event: 'update', payload: 7 }]);
  });

  it('honours a custom inbound eventName and decoder', () => {
    const socket = new FakeSocket();
    const adapter = socketio(socket, {
      eventName: 'liveflux',
      decode: (p) => ({ channel: 'c', event: 'e', payload: p }),
    });
    const rec = recorder();
    adapter.connect(rec);
    socket.serverConnect();
    socket.fire('liveflux', 42);
    expect(rec.events).toEqual([{ channel: 'c', event: 'e', payload: 42 }]);
    socket.fire('message', 99); // wrong event name → ignored
    expect(rec.events).toHaveLength(1);
  });

  it('replays the active subscriptions on reconnect', () => {
    const socket = new FakeSocket();
    const adapter = socketio(socket);
    const rec = recorder();
    adapter.connect(rec);
    socket.serverConnect();
    adapter.subscribe({ subId: 's1', channel: 'orders' });
    adapter.subscribe({ subId: 's2', channel: 'trades' });

    // simulate a transient drop, then the core-driven reconnect
    socket.connected = false;
    socket.fire('disconnect', 'transport close');
    socket.outbound.length = 0; // reset — inspect only the replay
    adapter.connect(rec);
    socket.serverConnect();
    const replayed = socket.outbound.filter((f) => f.event === 'subscribe').map((f) => f.args[0]);
    expect(replayed).toEqual([
      { subId: 's1', channel: 'orders' },
      { subId: 's2', channel: 'trades' },
    ]);
  });

  it('detaches on disconnect: no onClose and no further events', () => {
    const socket = new FakeSocket();
    const adapter = socketio(socket);
    const rec = recorder();
    adapter.connect(rec);
    socket.serverConnect();
    adapter.subscribe({ subId: 's1', channel: 'orders' });

    adapter.disconnect();
    expect(socket.disconnectCalls).toBe(1);
    socket.fire('disconnect', 'io client disconnect'); // any late lifecycle noise is ignored
    socket.fire('message', { channel: 'orders', event: 'update', payload: 1 });
    expect(rec.closes).toBe(0);
    expect(rec.events).toEqual([]);
  });

  describe('publish + request (bidirectional)', () => {
    it('emits a fire-and-forget publish frame (no ack callback)', () => {
      const socket = new FakeSocket();
      const adapter = socketio(socket);
      adapter.connect(recorder());
      socket.serverConnect();

      adapter.publish?.({ channel: 'orders', event: 'create', payload: { sku: 'A1' }, meta: { r: 1 } });
      const frame = socket.outbound.find((f) => f.event === 'publish');
      expect(frame?.args).toEqual([{ channel: 'orders', event: 'create', payload: { sku: 'A1' }, meta: { r: 1 } }]);
    });

    it('carries an idempotencyKey on the publish frame', () => {
      const socket = new FakeSocket();
      const adapter = socketio(socket);
      adapter.connect(recorder());
      socket.serverConnect();

      adapter.publish?.({ channel: 'orders', event: 'create', payload: 1, idempotencyKey: 'k-1' });
      const frame = socket.outbound.find((f) => f.event === 'publish');
      expect(frame?.args[0]).toEqual({ channel: 'orders', event: 'create', payload: 1, idempotencyKey: 'k-1' });
    });

    it('emits a request with an ack callback and routes the ack to onReply', () => {
      const socket = new FakeSocket();
      const adapter = socketio(socket);
      const rec = recorder();
      adapter.connect(rec);
      socket.serverConnect();

      adapter.request?.({ requestId: 'rq_1', channel: 'orders', event: 'create', payload: { sku: 'A1' } });
      const frame = socket.outbound.find((f) => f.event === 'request')!;
      expect(frame.args[0]).toEqual({ requestId: 'rq_1', channel: 'orders', event: 'create', payload: { sku: 'A1' } });
      const ack = frame.args[frame.args.length - 1] as (r: unknown) => void;
      expect(typeof ack).toBe('function');

      ack({ ok: true, payload: { id: 7 } }); // server acks
      expect(rec.replies).toEqual([{ requestId: 'rq_1', ok: true, payload: { id: 7 } }]);
    });

    it('treats a bare (non-envelope) ack value as a successful reply', () => {
      const socket = new FakeSocket();
      const adapter = socketio(socket);
      const rec = recorder();
      adapter.connect(rec);
      socket.serverConnect();

      adapter.request?.({ requestId: 'rq_2', channel: 'orders', event: 'sum', payload: [1, 2] });
      const ack = socket.outbound.find((f) => f.event === 'request')!.args[1] as (r: unknown) => void;
      ack(3); // server acks with a bare value
      expect(rec.replies).toEqual([{ requestId: 'rq_2', ok: true, payload: 3 }]);
    });

    it('routes an { ok:false } ack to onReply as a rejected reply', () => {
      const socket = new FakeSocket();
      const adapter = socketio(socket);
      const rec = recorder();
      adapter.connect(rec);
      socket.serverConnect();

      adapter.request?.({ requestId: 'rq_3', channel: 'orders', event: 'create', payload: {} });
      const ack = socket.outbound.find((f) => f.event === 'request')!.args[1] as (r: unknown) => void;
      ack({ ok: false, error: { message: 'nope', code: 'BAD' } });
      expect(rec.replies).toEqual([
        { requestId: 'rq_3', ok: false, error: { message: 'nope', code: 'BAD' } },
      ]);
    });
  });
});
