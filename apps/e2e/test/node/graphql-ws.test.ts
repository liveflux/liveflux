import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LivefluxClient } from '@liveflux/core';
import type { NormalizedEvent } from '@liveflux/core';
import { graphqlWs, type GraphqlWsOptions } from '@liveflux/graphql-ws';
import { GraphqlWsServer } from '../support/graphql-ws-server';
import { waitUntil } from '../support/async';

/**
 * Layer-3 integration — `@liveflux/graphql-ws` + `@liveflux/core` over a **real** `graphql-ws` server
 * (`useServer`) on a `ws` socket, driven through the public `LivefluxClient`. Exercises the genuine
 * protocol: `connection_init` → `connection_ack` (onOpen is gated on the ack), real `subscribe`
 * operations resolved by a schema, server `next` results, `complete` on unsubscribe, and reconnect
 * replay after a server drop. Waits are bounded (`waitUntil`) so the suite is fast and never hangs.
 */

const WsCtor = WebSocket as unknown as NonNullable<GraphqlWsOptions['WebSocket']>;

/** A liveflux channel → a `stream(channel:…)` subscription document. */
const query: NonNullable<GraphqlWsOptions['query']> = (channel) => ({
  query: 'subscription Stream($c: String!) { stream(channel: $c) { event payload } }',
  variables: { c: channel },
  operationName: 'Stream',
});

/** Unwrap the GraphQL `next` envelope back into the app's `{ event, payload }` shape. */
const decode: NonNullable<GraphqlWsOptions['decode']> = (payload, channel) => {
  const res = payload as { data?: { stream?: { event: string; payload: string } } };
  const s = res.data?.stream;
  if (!s) return null;
  return { channel, event: s.event, payload: JSON.parse(s.payload) };
};

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

function adapter(server: GraphqlWsServer) {
  return graphqlWs(() => server.url, { WebSocket: WsCtor, query, decode });
}

let server: GraphqlWsServer;

beforeEach(async () => {
  server = await GraphqlWsServer.start();
});
afterEach(async () => {
  await server.close();
});

describe('graphql-ws · handshake → subscribe → next → unsubscribe', () => {
  it('acks the connection, delivers a normalized event, then stops after unsubscribe', async () => {
    const client = new LivefluxClient({ adapter: adapter(server) });
    client.connect();

    // onOpen is gated on connection_ack — reaching 'open' proves the real handshake completed.
    await waitUntil(() => client.getConnectionState() === 'open', { label: 'connection_ack' });

    const feed = collect(client, 'orders');
    const fence = collect(client, 'fence');
    await waitUntil(() => server.subscribedChannels.length === 2, { label: 'both subs registered' });

    server.broadcast('orders', 'created', { id: 7, status: 'new' });
    await waitUntil(() => feed.events.length === 1, { label: 'first order event' });
    expect(feed.events[0]).toEqual({
      channel: 'orders',
      event: 'created',
      payload: { id: 7, status: 'new' },
    });

    feed.sub.destroy(); // sends `complete` — the server ends the orders subscription
    server.broadcast('orders', 'created', { id: 8 });
    server.broadcast('fence', 'ping', 1);
    await waitUntil(() => fence.events.length === 1, { label: 'fence event' });
    expect(feed.events).toHaveLength(1);

    client.destroy();
  });
});

describe('graphql-ws · reconnect replay', () => {
  it('re-handshakes on a fresh socket, replays the subscription, and resumes receiving', async () => {
    const client = new LivefluxClient({
      adapter: adapter(server),
      reconnect: { baseMs: 20, jitter: 0 },
    });
    client.connect();

    const feed = collect(client, 'orders');
    await waitUntil(() => server.subscribedChannels.length === 1, { label: 'initial subscribe' });
    server.broadcast('orders', 'created', { id: 1 });
    await waitUntil(() => feed.events.length === 1, { label: 'pre-drop event' });

    server.dropAll();
    await waitUntil(() => server.connectionCount >= 2, { label: 'reconnected socket' });
    await waitUntil(() => server.subscribedChannels.length >= 2, { label: 'sub replayed after ack' });
    expect(server.subscribedChannels.every((c) => c === 'orders')).toBe(true);

    server.broadcast('orders', 'created', { id: 2 });
    await waitUntil(() => feed.events.length === 2, { label: 'post-reconnect event' });
    expect(feed.events.map((e) => e.payload)).toEqual([{ id: 1 }, { id: 2 }]);

    client.destroy();
  });
});

describe('graphql-ws · subscribe before ack', () => {
  it('sends exactly one subscribe op per subId when subscribing before the ack', async () => {
    const client = new LivefluxClient({ adapter: adapter(server) });
    client.connect();
    collect(client, 'orders'); // issued before connection_ack

    await waitUntil(() => client.getConnectionState() === 'open', { label: 'connection_ack' });
    await waitUntil(() => server.subscribedChannels.length >= 1, { label: 'replayed subscribe' });
    expect(server.subscribedChannels.filter((c) => c === 'orders')).toHaveLength(1);

    // The event still flows on that single subscription.
    const feed = collect(client, 'orders'); // second reducer on same channel to observe delivery
    server.broadcast('orders', 'created', { id: 5 });
    await waitUntil(() => feed.events.length === 1, { label: 'event after early subscribe' });
    expect(feed.events[0]?.payload).toEqual({ id: 5 });

    client.destroy();
  });
});
