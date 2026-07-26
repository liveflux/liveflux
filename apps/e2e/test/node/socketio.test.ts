import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import { LivefluxClient } from '@liveflux/core';
import type { NormalizedEvent } from '@liveflux/core';
import { socketio, type SocketLike } from '@liveflux/socketio';
import { SocketioServer } from '../support/socketio-server';
import { waitUntil } from '../support/async';

/**
 * Layer-3 integration — `@liveflux/socketio` + `@liveflux/core` over a **real** in-process Socket.IO
 * server, driven through the public `LivefluxClient` with a genuine `socket.io-client` socket. Covers
 * connect → subscribe → event → unsubscribe, reconnect replay after a server-side disconnect,
 * subscribe-before-open, and adopting an already-connected socket. The client is created with
 * `reconnection: false` so the core owns the one backoff policy (as the adapter documents). Waits are
 * bounded (`waitUntil`) so the suite is fast and never hangs.
 */

function collect(client: LivefluxClient, channel: string) {
  const events: NormalizedEvent[] = [];
  const sub = client.subscribe<unknown, NormalizedEvent[]>({
    channel,
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

/** A fresh, non-auto-connecting client socket — the core drives connect + reconnect. */
function makeSocket(server: SocketioServer): SocketLike {
  return io(server.url, {
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
    forceNew: true,
  }) as unknown as SocketLike;
}

let server: SocketioServer;

beforeEach(async () => {
  server = await SocketioServer.start();
});
afterEach(async () => {
  await server.close();
});

describe('socketio · connect → subscribe → broadcast → unsubscribe', () => {
  it('delivers a normalized event, then stops after unsubscribe', async () => {
    const client = new LivefluxClient({ adapter: socketio(makeSocket(server)) });
    client.connect();

    const feed = collect(client, 'orders');
    const fence = collect(client, 'fence');
    await waitUntil(() => (server.latest?.subs.size ?? 0) === 2, { label: 'both subs registered' });

    server.broadcast('orders', 'created', { id: 7, status: 'new' });
    await waitUntil(() => feed.events.length === 1, { label: 'first order event' });
    expect(feed.events[0]).toEqual({
      channel: 'orders',
      event: 'created',
      payload: { id: 7, status: 'new' },
    });

    feed.sub.destroy();
    await waitUntil(() => (server.latest?.unsubscribes.length ?? 0) === 1, {
      label: 'unsubscribe frame received',
    });

    server.broadcast('orders', 'created', { id: 8 });
    server.broadcast('fence', 'ping', 1);
    await waitUntil(() => fence.events.length === 1, { label: 'fence event' });
    expect(feed.events).toHaveLength(1);

    client.destroy();
  });
});

describe('socketio · reconnect replay', () => {
  it('re-subscribes on a fresh socket and resumes receiving after a server disconnect', async () => {
    const client = new LivefluxClient({
      adapter: socketio(makeSocket(server)),
      reconnect: { baseMs: 20, jitter: 0 },
    });
    client.connect();

    const feed = collect(client, 'orders');
    await waitUntil(() => (server.latest?.subs.size ?? 0) === 1, { label: 'initial subscribe' });
    server.broadcast('orders', 'created', { id: 1 });
    await waitUntil(() => feed.events.length === 1, { label: 'pre-drop event' });

    server.dropAll();
    await waitUntil(() => server.connections.length >= 2, { label: 'reconnected' });
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

describe('socketio · subscribe before open', () => {
  it('sends exactly one subscribe frame per subId when subscribing before the socket connects', async () => {
    const client = new LivefluxClient({ adapter: socketio(makeSocket(server)) });
    client.connect();
    collect(client, 'orders'); // issued while the socket is still connecting

    await waitUntil(() => client.getConnectionState() === 'open', { label: 'socket open' });
    await waitUntil(() => server.allSubscribes().length >= 1, { label: 'replayed subscribe' });
    expect(server.allSubscribes().filter((s) => s.channel === 'orders')).toHaveLength(1);

    client.destroy();
  });
});

describe('socketio · adopts an already-connected socket', () => {
  it('opens immediately when handed a live socket', async () => {
    const socket = makeSocket(server);
    socket.connect();
    await waitUntil(() => socket.connected, { label: 'raw socket connected' });

    const client = new LivefluxClient({ adapter: socketio(socket) });
    client.connect();
    const feed = collect(client, 'orders');

    await waitUntil(() => (server.latest?.subs.size ?? 0) === 1, { label: 'subscribed on live socket' });
    server.broadcast('orders', 'created', { id: 3 });
    await waitUntil(() => feed.events.length === 1, { label: 'event on adopted socket' });
    expect(feed.events[0]?.payload).toEqual({ id: 3 });

    client.destroy();
  });
});
