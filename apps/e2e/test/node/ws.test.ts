import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { NormalizedEvent } from '@liveflux/core';
import { ws } from '@liveflux/ws';
import type { OutboundFrame } from '@liveflux/ws';
import { WsClientCtor } from '../support/node-ws';
import { WsControlServer } from '../support/ws-server';
import { waitUntil } from '../support/async';

/**
 * Layer-3 integration — `@liveflux/ws` + `@liveflux/core` over a **real** in-process `ws` server,
 * driven through the public `LivefluxClient`. Every assertion rides a genuine localhost socket:
 * connect, subscribe, broadcast, unsubscribe, reconnect replay, dynamic-URL re-auth, heartbeat, and
 * the custom encode/decode + oversized-frame seams. Waits are bounded (`waitUntil`) so the suite is
 * fast and can never hang.
 */

/** Capture full NormalizedEvents (channel/event/payload/cursor/meta) via a reducer fold. */
function collect(client: LivefluxClient, channel: string, params?: Record<string, unknown>) {
  const events: NormalizedEvent[] = [];
  const sub = client.subscribe<unknown, NormalizedEvent[]>({
    channel,
    ...(params ? { params } : {}),
    into: {
      strategy: 'reducer',
      initial: events,
      reduce: (acc, event) => {
        acc.push(event);
        return acc;
      },
    },
  });
  return { events, sub };
}

let server: WsControlServer;

beforeEach(async () => {
  server = await WsControlServer.start();
});
afterEach(async () => {
  await server.close();
});

describe('ws · connect → subscribe → broadcast → unsubscribe', () => {
  it('delivers a normalized event, then stops after unsubscribe', async () => {
    const adapter = ws(server.url(), { WebSocket: WsClientCtor });
    const client = new LivefluxClient({ adapter });
    client.connect();

    const feed = collect(client, 'orders');
    const fence = collect(client, 'fence'); // a still-subscribed channel used as an ordering fence

    await waitUntil(() => server.latest?.subs.size === 2, { label: 'both subs registered' });

    server.broadcast('orders', 'created', { id: 7, status: 'new' });
    await waitUntil(() => feed.events.length === 1, { label: 'first order event' });
    expect(feed.events[0]).toEqual({
      channel: 'orders',
      event: 'created',
      payload: { id: 7, status: 'new' },
    });

    // Unsubscribe 'orders' and wait for the wire frame to reach the server.
    feed.sub.destroy();
    await waitUntil(() => (server.latest?.unsubscribes.length ?? 0) === 1, {
      label: 'unsubscribe frame received',
    });

    // Broadcast on the (now-unsubscribed) orders channel, then on the live fence channel. When the
    // fence event arrives we know the orders one — if it had been delivered — would have too.
    server.broadcast('orders', 'created', { id: 8 });
    server.broadcast('fence', 'ping', 1);
    await waitUntil(() => fence.events.length === 1, { label: 'fence event' });
    expect(feed.events).toHaveLength(1); // no post-unsubscribe delivery

    client.destroy();
  });
});

describe('ws · reconnect replay', () => {
  it('re-subscribes on a fresh connection and resumes receiving after a server drop', async () => {
    const adapter = ws(server.url(), { WebSocket: WsClientCtor });
    const client = new LivefluxClient({ adapter, reconnect: { baseMs: 20, jitter: 0 } });
    client.connect();

    const feed = collect(client, 'orders');
    await waitUntil(() => server.latest?.subs.has([...server.latest.subs.keys()][0] ?? '') === true, {
      label: 'initial subscribe',
    });
    server.broadcast('orders', 'created', { id: 1 });
    await waitUntil(() => feed.events.length === 1, { label: 'pre-drop event' });

    // Server abruptly kills the socket; the client backs off and reconnects.
    server.dropAll();
    await waitUntil(() => server.connections.length >= 2, { label: 'reconnected' });
    // The adapter replays the active set on the fresh connection — the server sees the re-subscribe.
    await waitUntil(() => (server.latest?.subscribes.length ?? 0) >= 1, {
      label: 'sub replayed on reconnect',
    });
    expect(server.latest?.subscribes.some((s) => s.channel === 'orders')).toBe(true);

    server.broadcast('orders', 'created', { id: 2 });
    await waitUntil(() => feed.events.length === 2, { label: 'post-reconnect event' });
    expect(feed.events.map((e) => e.payload)).toEqual([{ id: 1 }, { id: 2 }]);

    client.destroy();
  });
});

describe('ws · subscribe before open', () => {
  it('sends exactly one subscribe frame per subId when subscribing before the socket opens', async () => {
    const adapter = ws(server.url(), { WebSocket: WsClientCtor });
    const client = new LivefluxClient({ adapter });
    client.connect();
    // Subscribe immediately — the socket is still CONNECTING, so the adapter must cache and replay
    // exactly once on open (never lost, never double-sent).
    collect(client, 'orders');

    await waitUntil(() => client.getConnectionState() === 'open', { label: 'socket open' });
    await waitUntil(() => (server.latest?.subscribes.length ?? 0) >= 1, { label: 'replayed subscribe' });
    const ordersFrames = server.allSubscribes().filter((s) => s.channel === 'orders');
    expect(ordersFrames).toHaveLength(1);

    client.destroy();
  });
});

describe('ws · dynamic URL re-auth on reconnect', () => {
  it('re-invokes the url function on each connect so a rotated token reaches the server', async () => {
    let token = 0;
    const adapter = ws(() => server.url(`?token=${++token}`), { WebSocket: WsClientCtor });
    const client = new LivefluxClient({ adapter, reconnect: { baseMs: 20, jitter: 0 } });
    client.connect();

    collect(client, 'orders');
    await waitUntil(() => client.getConnectionState() === 'open', { label: 'first connect' });
    expect(server.connections[0]?.query).toBe('token=1');

    server.dropAll();
    await waitUntil(() => server.connections.length >= 2, { label: 'second connect' });
    expect(server.connections[1]?.query).toBe('token=2'); // refreshed token on the reconnect

    client.destroy();
  });
});

describe('ws · dynamic protocols re-auth on reconnect', () => {
  it('re-invokes the protocols function on each connect so a rotated subprotocol reaches the server', async () => {
    let token = 0;
    const adapter = ws(server.url(), {
      WebSocket: WsClientCtor,
      protocols: () => [`bearer.${++token}`],
    });
    const client = new LivefluxClient({ adapter, reconnect: { baseMs: 20, jitter: 0 } });
    client.connect();

    collect(client, 'orders');
    await waitUntil(() => client.getConnectionState() === 'open', { label: 'first connect' });
    // The first socket offered the first-minted subprotocol.
    expect(server.connections[0]?.protocol).toBe('bearer.1');

    server.dropAll();
    await waitUntil(() => server.connections.length >= 2, { label: 'second connect' });
    await waitUntil(() => client.getConnectionState() === 'open', { label: 'reconnected open' });
    // The reconnect re-resolved the function → a freshly-rotated subprotocol on the new socket.
    expect(server.connections[1]?.protocol).toBe('bearer.2');

    client.destroy();
  });
});

describe('ws · heartbeat over the wire', () => {
  it('emits keepalive frames the server observes while open', async () => {
    const adapter = ws(server.url(), { WebSocket: WsClientCtor });
    const client = new LivefluxClient({
      adapter,
      heartbeat: { enabled: true, intervalMs: 15 },
    });
    client.connect();
    collect(client, 'orders');

    await waitUntil(() => (server.latest?.heartbeats ?? 0) >= 2, { label: 'heartbeats received' });
    expect(server.latest?.heartbeats).toBeGreaterThanOrEqual(2);

    client.destroy();
  });
});

describe('ws · custom encode / decode', () => {
  it('encodes control frames and decodes events through the supplied seams', async () => {
    // A custom envelope protocol: outbound frames wrapped as { t, ...frame }; inbound events are
    // lifted out of a { kind:'evt', ch, name, body, cursor } envelope.
    const encode = (frame: OutboundFrame): string => JSON.stringify({ t: frame.type, frame });
    const decode = (raw: unknown): NormalizedEvent | null => {
      if (typeof raw !== 'string') return null;
      const msg = JSON.parse(raw) as { kind?: string; ch?: string; name?: string; body?: unknown; cursor?: string };
      if (msg.kind !== 'evt' || typeof msg.ch !== 'string' || typeof msg.name !== 'string') return null;
      return { channel: msg.ch, event: msg.name, payload: msg.body, ...(msg.cursor ? { cursor: msg.cursor } : {}) };
    };
    const adapter = ws(server.url(), { WebSocket: WsClientCtor, encode, decode });
    const client = new LivefluxClient({ adapter });
    client.connect();
    const feed = collect(client, 'orders');

    // The server received the custom-encoded subscribe wire string.
    await waitUntil(() => (server.latest?.rawMessages.length ?? 0) >= 1, { label: 'raw subscribe' });
    const raw = server.latest!.rawMessages[0]!;
    expect(JSON.parse(raw)).toMatchObject({ t: 'subscribe', frame: { channel: 'orders' } });

    // Push a custom-envelope event; the decode seam lifts it into a NormalizedEvent.
    server.latest!.socket.send(
      JSON.stringify({ kind: 'evt', ch: 'orders', name: 'filled', body: { id: 9 }, cursor: 'c1' }),
    );
    await waitUntil(() => feed.events.length === 1, { label: 'decoded custom event' });
    expect(feed.events[0]).toEqual({
      channel: 'orders',
      event: 'filled',
      payload: { id: 9 },
      cursor: 'c1',
    });

    client.destroy();
  });
});

describe('ws · maxMessageBytes guard', () => {
  it('drops an oversized inbound frame before decoding, but delivers a small one', async () => {
    const adapter = ws(server.url(), { WebSocket: WsClientCtor, maxMessageBytes: 200 });
    const client = new LivefluxClient({ adapter });
    client.connect();
    const feed = collect(client, 'orders');
    await waitUntil(() => server.latest?.subs.size === 1, { label: 'subscribed' });

    // Oversized: a payload well beyond the 200-byte cap → dropped silently.
    server.broadcast('orders', 'big', { blob: 'x'.repeat(500) });
    // Small fence event that fits → delivered; its arrival proves the big one was skipped, not queued.
    server.broadcast('orders', 'small', { ok: true });
    await waitUntil(() => feed.events.length === 1, { label: 'small event delivered' });
    expect(feed.events[0]?.event).toBe('small');
    expect(feed.events).toHaveLength(1);

    client.destroy();
  });
});
