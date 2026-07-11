import { afterEach, describe, expect, it, vi } from 'vitest';
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
/** The `join_ref` the adapter minted for the most recent outbound frame of a socket. */
const lastJoinRef = (socket: MockWebSocket): string => frames(socket).at(-1)![0] as string;

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
    vi.useRealTimers();
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
    expect(frames(last())).toEqual([['sub_1#1', '1', 'orders', 'phx_join', {}]]);
  });

  it('encodes a join as [join_ref, ref, topic, phx_join, params] with a subId-derived join_ref', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    adapter.connect(handlers());
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders', params: { region: 'eu' } });
    expect(frames(last())).toEqual([['sub_1#1', '1', 'orders', 'phx_join', { region: 'eu' }]]);
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
    // reply carries the same ref + current join_ref the join was sent with
    last().emit(
      serverFrame([
        lastJoinRef(last()),
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
    last().emit(
      serverFrame([lastJoinRef(last()), '1', 'orders', 'phx_reply', { status: 'ok', response: {} }]),
    );
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

  it('surfaces a phx_error and transparently re-joins the channel after backoff', () => {
    vi.useFakeTimers();
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    const s = last();
    s.open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    const joinRef = lastJoinRef(s); // 'sub_1#1'
    s.sent.length = 0; // isolate what the phx_error triggers

    s.emit(serverFrame([joinRef, null, 'orders', 'phx_error', {}]));
    expect(h.errors).toBe(1);
    expect(h.errorValues[0]).toMatchObject({ type: 'channel_error', channel: 'orders' });
    expect(s.sent).toHaveLength(0); // backoff — not an immediate hot re-join

    vi.advanceTimersByTime(100);
    const rejoin = frames(s);
    expect(rejoin).toHaveLength(1);
    expect(rejoin[0]![3]).toBe('phx_join');
    expect(rejoin[0]![2]).toBe('orders');
    expect(rejoin[0]![0]).toBe('sub_1#2'); // a fresh join instance, not the crashed one
  });

  it('ignores a stale phx_error from a superseded join instance', () => {
    vi.useFakeTimers();
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    const s = last();
    s.open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    const stale = lastJoinRef(s); // 'sub_1#1'

    s.emit(serverFrame([stale, null, 'orders', 'phx_error', {}])); // live → error + re-join scheduled
    vi.advanceTimersByTime(100); // re-join mints 'sub_1#2'; 'sub_1#1' is now superseded
    expect(h.errors).toBe(1);

    s.emit(serverFrame([stale, null, 'orders', 'phx_error', {}])); // from the crashed instance
    expect(h.errors).toBe(1); // ignored — no second error, no second re-join loop
  });

  it('ignores a phx_reply whose join_ref names a superseded instance', () => {
    vi.useFakeTimers();
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    const s = last();
    s.open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' }); // join #1: join_ref 'sub_1#1', ref '1'
    const superseded = lastJoinRef(s); // 'sub_1#1'

    // Force a re-join (mints 'sub_1#2') while join #1 is still in-flight (ref '1' never replied).
    s.emit(serverFrame([superseded, null, 'orders', 'phx_error', {}]));
    vi.advanceTimersByTime(100);
    expect(h.errors).toBe(1); // channel_error from the phx_error

    // A late error reply for the original join arrives; its join_ref is no longer current → ignored.
    s.emit(serverFrame([superseded, '1', 'orders', 'phx_reply', { status: 'error', response: {} }]));
    expect(h.errors).toBe(1); // no join_error surfaced
  });

  it('unsubscribe sends phx_leave and stops re-joining on reconnect', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    adapter.unsubscribe('sub_1');
    expect(frames(last())[1]).toEqual(['sub_1#1', '2', 'orders', 'phx_leave', {}]);

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
      ['sub_1#1', '1', 'orders', 'phx_join', {}], // ref + join-instance counters reset per connection
      ['sub_2#2', '2', 'trades', 'phx_join', { symbol: 'ACME' }],
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
    expect(calls).toEqual([['sub_1#1', '1', 'orders', 'phx_join', {}]]);
  });

  it('routes inbound events by topic with many subs and multiple subs per topic', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    last().open();
    // A large fan-out across distinct topics, plus two subs sharing one topic.
    for (let i = 0; i < 200; i += 1) adapter.subscribe({ subId: `s${i}`, channel: `t${i}` });
    adapter.subscribe({ subId: 'a1', channel: 'shared' });
    adapter.subscribe({ subId: 'a2', channel: 'shared' });

    last().emit(serverFrame([null, null, 'shared', 'evt', { n: 1 }]));
    expect(h.events).toHaveLength(1); // delivered once per topic, not once per sub

    adapter.unsubscribe('a1'); // topic still active via a2 (ref-counted)
    last().emit(serverFrame([null, null, 'shared', 'evt', { n: 2 }]));
    expect(h.events).toHaveLength(2);

    adapter.unsubscribe('a2'); // last sub on the topic gone → topic no longer routes
    last().emit(serverFrame([null, null, 'shared', 'evt', { n: 3 }]));
    expect(h.events).toHaveLength(2);
  });

  it('re-invokes a params function on every (re)connect (token refresh)', () => {
    let n = 0;
    const adapter = phoenix('wss://x/socket', {
      WebSocket: MockCtor,
      params: () => ({ token: `t${(n += 1)}` }),
    });
    adapter.connect(handlers());
    expect(new URL(last().url).searchParams.get('token')).toBe('t1');
    last().open();

    adapter.connect(handlers()); // reconnect → the function runs again
    expect(new URL(last().url).searchParams.get('token')).toBe('t2');
  });

  it('retries a join that gets no phx_reply within joinTimeoutMs', () => {
    vi.useFakeTimers();
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor, joinTimeoutMs: 100 });
    adapter.connect(handlers());
    const s = last();
    s.open();
    adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
    expect(frames(s)).toHaveLength(1); // join #1
    s.sent.length = 0;

    vi.advanceTimersByTime(100); // join timeout fires → schedules a re-join
    vi.advanceTimersByTime(100); // backoff elapses → re-join sent
    const retry = frames(s);
    expect(retry).toHaveLength(1);
    expect(retry[0]![3]).toBe('phx_join');
    expect(retry[0]![0]).toBe('sub_1#2'); // a fresh join instance
  });

  it('closes a zombie socket when a heartbeat goes unacked before the next tick', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    const s = last();
    s.open();

    adapter.heartbeat?.();
    expect(frames(s)).toEqual([[null, '1', 'phoenix', 'heartbeat', {}]]);

    adapter.heartbeat?.(); // previous heartbeat still unacked → dead link
    expect(s.readyState).toBe(3); // socket closed (fires onClose → core reconnects)
    expect(s.sent).toHaveLength(1); // no second heartbeat queued
  });

  it('keeps heartbeating once the previous heartbeat is acked', () => {
    const adapter = phoenix('wss://x/socket', { WebSocket: MockCtor });
    const h = handlers();
    adapter.connect(h);
    const s = last();
    s.open();

    adapter.heartbeat?.(); // ref '1'
    s.emit(serverFrame([null, '1', 'phoenix', 'phx_reply', { status: 'ok', response: {} }])); // ack
    adapter.heartbeat?.(); // ref '2' — link is healthy, another heartbeat goes out
    expect(s.readyState).toBe(1);
    expect(frames(s).map((f) => f[1])).toEqual(['1', '2']);
  });
});
