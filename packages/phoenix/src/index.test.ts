import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterHandlers } from '@liveflux/core';
import { phoenix, type PhoenixMessage, type PhoenixOptions } from './index';

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

  constructor(readonly url: string) {
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
  drop(reason?: unknown): void {
    this.readyState = 3;
    this.onclose?.(reason);
  }
}

const MockCtor = MockWebSocket as unknown as PhoenixOptions['WebSocket'];
const last = () => instances[instances.length - 1]!;
const frames = (socket: MockWebSocket): PhoenixMessage[] =>
  socket.sent.map((raw) => JSON.parse(raw) as PhoenixMessage);
const serverFrame = (message: PhoenixMessage): string => JSON.stringify(message);

function handlers() {
  const h = {
    opens: 0,
    closes: 0,
    errors: 0,
    events: [] as unknown[],
    errorValues: [] as unknown[],
    closeReasons: [] as unknown[],
    onOpen() {
      h.opens += 1;
    },
    onClose(reason?: unknown) {
      h.closes += 1;
      h.closeReasons.push(reason);
    },
    onError(err: unknown) {
      h.errors += 1;
      h.errorValues.push(err);
    },
    onEvent(e: unknown) {
      h.events.push(e);
    },
  };
  return h satisfies AdapterHandlers & Record<string, unknown>;
}

describe('phoenix adapter', () => {
  afterEach(() => {
    instances = [];
  });

  it('connects with the vsn and connect params in the query string', () => {
    const adapter = phoenix('wss://x/socket', {
      WebSocket: MockCtor,
      params: { token: 'abc' },
      vsn: '2.0.0',
    });
    adapter.connect(handlers());
    const url = new URL(last().url);
    expect(url.searchParams.get('vsn')).toBe('2.0.0');
    expect(url.searchParams.get('token')).toBe('abc');
    last().open();
  });

  it('appends the query with & when the URL already carries one', () => {
    const adapter = phoenix('wss://x/socket?existing=1', { WebSocket: MockCtor });
    adapter.connect(handlers());
    expect(last().url).toContain('?existing=1&');
    expect(last().url).toContain('vsn=2.0.0');
  });

  it('fires onOpen when the socket opens', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    expect(h.opens).toBe(1);
  });

  it('buffers a subscribe until open, then joins exactly once (no double-send)', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    adapter.connect(handlers());
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' }); // before open
    expect(last().sent).toHaveLength(0);
    last().open();
    expect(frames(last())).toEqual([['sub_1', '1', 'orders', 'phx_join', {}]]);
  });

  it('encodes a join as [subId, ref, topic, phx_join, params] using subId as join_ref', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    adapter.connect(handlers());
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders', params: { region: 'eu' } });
    expect(frames(last())).toEqual([['sub_1', '1', 'orders', 'phx_join', { region: 'eu' }]]);
  });

  it('uses a fresh monotonic ref per outbound request', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    adapter.connect(handlers());
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    adapter.subscribe({ subId: 'sub_2', channel: 'trades' });
    expect(frames(last()).map((f) => f[1])).toEqual(['1', '2']);
  });

  it('normalizes a broadcast to onEvent for the matching topic', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    last().emit(serverFrame([null, null, 'orders', 'new_order', { id: 7 }]));
    expect(h.events).toEqual([{ channel: 'orders', event: 'new_order', payload: { id: 7 } }]);
  });

  it('ignores events for topics with no active subscription', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    last().emit(serverFrame([null, null, 'orders', 'new_order', { id: 7 }]));
    expect(h.events).toEqual([]);
  });

  it('ignores malformed frames (non-array, short tuple, non-string topic/event)', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    last().emit('not json');
    last().emit(JSON.stringify({ not: 'an array' }));
    last().emit(JSON.stringify([null, null, 'orders'])); // too short
    last().emit(JSON.stringify([null, null, 5, 'evt', {}])); // non-string topic
    expect(h.events).toEqual([]);
    expect(h.errors).toBe(0);
  });

  it('surfaces a rejected join via onError (correlated by ref)', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    // reply carries the same ref the join was sent with
    last().emit(
      serverFrame([
        'sub_1',
        '1',
        'orders',
        'phx_reply',
        { status: 'error', response: { reason: 'unauthorized' } },
      ]),
    );
    expect(h.errors).toBe(1);
    expect(h.errorValues[0]).toMatchObject({ type: 'join_error', channel: 'orders' });
  });

  it('consumes a successful join reply silently', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    last().emit(serverFrame(['sub_1', '1', 'orders', 'phx_reply', { status: 'ok', response: {} }]));
    expect(h.errors).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('ignores a reply whose ref matches no pending join (e.g. a heartbeat reply)', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    last().emit(serverFrame([null, '99', 'phoenix', 'phx_reply', { status: 'ok', response: {} }]));
    expect(h.errors).toBe(0);
  });

  it('surfaces a phx_error for an active channel', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    last().emit(serverFrame(['sub_1', null, 'orders', 'phx_error', {}]));
    expect(h.errors).toBe(1);
    expect(h.errorValues[0]).toMatchObject({ type: 'channel_error', channel: 'orders' });
  });

  it('unsubscribe sends phx_leave and stops re-joining on reconnect', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    adapter.unsubscribe('sub_1');
    expect(frames(last())[1]).toEqual(['sub_1', '2', 'orders', 'phx_leave', {}]);

    adapter.connect(h); // reconnect
    last().open();
    expect(last().sent).toHaveLength(0); // sub_1 is no longer active
  });

  it('re-joins the active set on reconnect with a fresh ref sequence', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    adapter.subscribe({ subId: 'sub_2', channel: 'trades', params: { symbol: 'ACME' } });

    const firstSocket = last();
    adapter.connect(h); // reconnect → fresh socket
    expect(firstSocket.readyState).toBe(3); // prior socket retired, not leaked
    last().open();
    expect(frames(last())).toEqual([
      ['sub_1', '1', 'orders', 'phx_join', {}], // ref counter reset per connection
      ['sub_2', '2', 'trades', 'phx_join', { symbol: 'ACME' }],
    ]);
  });

  it('sends a heartbeat on the reserved phoenix topic when open', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    adapter.connect(handlers());
    last().open();
    adapter.heartbeat?.();
    expect(frames(last())).toEqual([[null, '1', 'phoenix', 'heartbeat', {}]]);
  });

  it('drops a heartbeat (never queues it) while congested', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor, maxBufferedAmount: 100 });
    adapter.connect(handlers());
    const s = last();
    s.open();
    s.bufferedAmount = 200; // congested
    adapter.heartbeat?.();
    expect(s.sent).toHaveLength(0);
  });

  it('drops inbound frames larger than maxMessageBytes before parsing (DoS guard)', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor, maxMessageBytes: 40 });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    last().emit(serverFrame([null, null, 'orders', 'evt', { blob: 'x'.repeat(100) }])); // dropped
    expect(h.events).toEqual([]);
    last().emit(serverFrame([null, null, 'orders', 'evt', 1])); // within cap → delivered
    expect(h.events).toEqual([{ channel: 'orders', event: 'evt', payload: 1 }]);
  });

  it('closes the socket on disconnect and detaches its handlers', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    const socket = last();
    socket.open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    adapter.disconnect();
    expect(socket.readyState).toBe(3);
    socket.emit(serverFrame([null, null, 'orders', 'evt', 1])); // late event from retired socket
    expect(h.events).toEqual([]);
  });

  it('reports onClose with the close reason', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    last().drop('network-loss');
    expect(h.closes).toBe(1);
    expect(h.closeReasons).toEqual(['network-loss']);
  });

  it('supports a custom decode that lifts cursor and meta from an enriched payload', () => {
    const adapter = phoenix('wss://x/socket', {
      WebSocket: MockCtor,
      decode: ([, , topic, event, payload]) => {
        const env = payload as { data: unknown; cursor?: string };
        return { channel: topic, event, payload: env.data, cursor: env.cursor };
      },
    });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    last().emit(serverFrame([null, null, 'orders', 'evt', { data: { id: 1 }, cursor: 'c-1' }]));
    expect(h.events).toEqual([
      { channel: 'orders', event: 'evt', payload: { id: 1 }, cursor: 'c-1' },
    ]);
  });

  it('supports a custom encode', () => {
    const calls: PhoenixMessage[] = [];
    const adapter = phoenix('wss://x/socket', {
      WebSocket: MockCtor,
      encode: (message) => {
        calls.push(message);
        return JSON.stringify(message);
      },
    });
    adapter.connect(handlers());
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    expect(calls).toEqual([['sub_1', '1', 'orders', 'phx_join', {}]]);
  });
});
