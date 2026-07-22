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
} {
  const rec = {
    opens: 0,
    closes: 0,
    errors: [] as unknown[],
    events: [] as NormalizedEvent[],
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
});
