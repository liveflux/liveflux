import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterHandlers } from '@liveflux/core';
import { ws, type WsOptions } from './index';

let instances: MockWebSocket[] = [];

/** Controllable WebSocket double. */
class MockWebSocket {
  readyState = 0; // CONNECTING
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }

  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const MockCtor = MockWebSocket as unknown as WsOptions['WebSocket'];
const last = () => instances[instances.length - 1]!;

function handlers() {
  const h = {
    opens: 0,
    closes: 0,
    errors: 0,
    events: [] as unknown[],
    onOpen() {
      h.opens += 1;
    },
    onClose() {
      h.closes += 1;
    },
    onError() {
      h.errors += 1;
    },
    onEvent(e: unknown) {
      h.events.push(e);
    },
  };
  return h satisfies AdapterHandlers & Record<string, unknown>;
}

describe('ws adapter', () => {
  afterEach(() => {
    instances = [];
  });

  it('opens the socket and fires onOpen', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    expect(last().url).toBe('wss://x');
    last().open();
    expect(h.opens).toBe(1);
  });

  it('buffers a subscribe until open, then flushes it', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    adapter.connect(handlers());
    adapter.subscribe({ subId: 's1', channel: 'trades' }); // before open
    expect(last().sent).toHaveLength(0);
    last().open();
    expect(JSON.parse(last().sent[0]!)).toEqual({
      type: 'subscribe',
      subId: 's1',
      channel: 'trades',
    });
  });

  it('sends a subscribe immediately when already open (with params)', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    adapter.connect(handlers());
    last().open();
    adapter.subscribe({ subId: 's1', channel: 'trades', params: { symbol: 'X' } });
    expect(JSON.parse(last().sent[0]!)).toEqual({
      type: 'subscribe',
      subId: 's1',
      channel: 'trades',
      params: { symbol: 'X' },
    });
  });

  it('drops inbound frames larger than maxMessageBytes before decoding (DoS guard)', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor, maxMessageBytes: 40 });
    const h = handlers();
    adapter.connect(h);
    last().open();
    const oversized = JSON.stringify({ channel: 'c', event: 'e', payload: 'x'.repeat(100) });
    last().emit(oversized); // > 40 chars → dropped without parsing
    expect(h.events).toEqual([]);
    last().emit(JSON.stringify({ channel: 'c', event: 'e', payload: 1 })); // within cap → delivered
    expect(h.events).toEqual([{ channel: 'c', event: 'e', payload: 1 }]);
  });

  it('decodes inbound events and ignores non-events', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    last().emit(JSON.stringify({ channel: 'trades', event: 'update', payload: { id: 1 } }));
    last().emit(JSON.stringify({ type: 'ack' })); // no channel/event → ignored
    last().emit('not json'); // ignored
    expect(h.events).toEqual([{ channel: 'trades', event: 'update', payload: { id: 1 } }]);
  });

  it('re-sends active subscriptions on reconnect', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 's1', channel: 'trades' });

    const firstSocket = last();
    adapter.connect(h); // reconnect → fresh socket
    expect(firstSocket.readyState).toBe(3); // prior socket retired (closed), not leaked
    expect(last()).not.toBe(firstSocket);
    last().open();
    expect(JSON.parse(last().sent[0]!)).toEqual({
      type: 'subscribe',
      subId: 's1',
      channel: 'trades',
    });
  });

  it('closes the socket on disconnect and detaches its handlers', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    const socket = last();
    socket.open();
    adapter.disconnect();
    expect(socket.readyState).toBe(3);
    // A late event from the retired socket must not reach the handlers.
    socket.emit(JSON.stringify({ channel: 'trades', event: 'update', payload: 1 }));
    expect(h.events).toEqual([]);
  });

  it('unsubscribe sends a frame and stops re-subscribing on reconnect', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 's1', channel: 'trades' });
    adapter.unsubscribe('s1');
    expect(JSON.parse(last().sent[1]!)).toEqual({ type: 'unsubscribe', subId: 's1' });

    adapter.connect(h); // reconnect
    last().open();
    expect(last().sent).toHaveLength(0); // s1 no longer active
  });

  it('sends a heartbeat frame when open', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    adapter.connect(handlers());
    last().open();
    adapter.heartbeat?.();
    expect(JSON.parse(last().sent[0]!)).toEqual({ type: 'heartbeat' });
  });

  it('applies outbound backpressure: queues while congested, flushes as the buffer drains', () => {
    vi.useFakeTimers();
    try {
      const adapter = ws('wss://x', { WebSocket: MockCtor, maxBufferedAmount: 100 });
      adapter.connect(handlers());
      const s = last();
      s.open();
      s.bufferedAmount = 200; // congested → over the high-water mark
      adapter.subscribe({ subId: 's1', channel: 'trades' });
      expect(s.sent).toHaveLength(0); // queued, not sent
      s.bufferedAmount = 0; // buffer drains
      vi.advanceTimersByTime(20); // scheduled flush fires
      expect(JSON.parse(s.sent[0]!)).toEqual({ type: 'subscribe', subId: 's1', channel: 'trades' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops heartbeats (never queues them) while congested', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor, maxBufferedAmount: 100 });
    adapter.connect(handlers());
    const s = last();
    s.open();
    s.bufferedAmount = 200; // congested
    adapter.heartbeat?.();
    expect(s.sent).toHaveLength(0); // dropped, not buffered
  });

  it('does no dangling work after disconnect (pending flush cancelled)', () => {
    vi.useFakeTimers();
    try {
      const adapter = ws('wss://x', { WebSocket: MockCtor, maxBufferedAmount: 100 });
      adapter.connect(handlers());
      const s = last();
      s.open();
      s.bufferedAmount = 200; // congested → queued + a flush scheduled
      adapter.subscribe({ subId: 's1', channel: 'trades' });
      expect(s.sent).toHaveLength(0);
      adapter.disconnect();
      s.bufferedAmount = 0;
      vi.advanceTimersByTime(50); // no queued frame should be sent through the retired socket
      expect(s.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a pre-open subscribe exactly once on open (no eager-push + replay duplication)', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    adapter.connect(handlers());
    adapter.subscribe({ subId: 's1', channel: 'trades' }); // before open → held, not pushed
    expect(last().sent).toHaveLength(0);
    last().open(); // onopen replays the active set
    const subscribes = last().sent.filter((raw) => JSON.parse(raw).type === 'subscribe');
    expect(subscribes).toHaveLength(1); // exactly one frame for s1, not two
    expect(JSON.parse(subscribes[0]!)).toEqual({ type: 'subscribe', subId: 's1', channel: 'trades' });
  });

  it('treats an unknown or already-removed unsubscribe as a no-op (no frame)', () => {
    const adapter = ws('wss://x', { WebSocket: MockCtor });
    adapter.connect(handlers());
    last().open();
    adapter.unsubscribe('never'); // unknown subId → nothing on the wire
    expect(last().sent).toHaveLength(0);

    adapter.subscribe({ subId: 's1', channel: 'trades' });
    adapter.unsubscribe('s1');
    adapter.unsubscribe('s1'); // already removed → still just the one unsubscribe frame
    const unsubs = last().sent.filter((raw) => JSON.parse(raw).type === 'unsubscribe');
    expect(unsubs).toHaveLength(1);
    expect(JSON.parse(unsubs[0]!)).toEqual({ type: 'unsubscribe', subId: 's1' });
  });

  it('re-resolves a function url (and protocols) on every (re)connect', () => {
    let token = 'token-1';
    const adapter = ws(() => `wss://x?token=${token}`, {
      WebSocket: MockCtor,
      protocols: () => [`bearer.${token}`],
    });
    adapter.connect(handlers());
    expect(last().url).toBe('wss://x?token=token-1');
    expect(last().protocols).toEqual(['bearer.token-1']);

    token = 'token-2'; // token rotates before the reconnect
    adapter.connect(handlers()); // reconnect re-resolves both
    expect(last().url).toBe('wss://x?token=token-2');
    expect(last().protocols).toEqual(['bearer.token-2']);
  });

  it('supports a custom decode', () => {
    const adapter = ws('wss://x', {
      WebSocket: MockCtor,
      decode: (raw) => ({ channel: 'c', event: 'e', payload: raw }),
    });
    const h = handlers();
    adapter.connect(h);
    last().open();
    last().emit('anything');
    expect(h.events).toEqual([{ channel: 'c', event: 'e', payload: 'anything' }]);
  });
});
