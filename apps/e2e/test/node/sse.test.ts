import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventSource } from 'eventsource';
import { LivefluxClient } from '@liveflux/core';
import type { NormalizedEvent } from '@liveflux/core';
import { sse, type SseOptions } from '@liveflux/sse';
import { SseServer } from '../support/sse-server';
import { waitUntil } from '../support/async';

/**
 * Layer-3 integration — `@liveflux/sse` + `@liveflux/core` over a **real** in-process SSE backend,
 * driven through the public `LivefluxClient`. Every assertion rides genuine localhost HTTP: the
 * downstream `text/event-stream` (a real `eventsource` client) and the upstream control channel (a
 * real `POST` via Node's global `fetch`). Covers connect → subscribe → event → unsubscribe,
 * reconnect replay after a server drop, subscribe-before-open, the SSE `id:` → cursor thread, and
 * the oversized-frame guard. Waits are bounded (`waitUntil`) so the suite is fast and never hangs.
 */

const ES = EventSource as unknown as NonNullable<SseOptions['EventSource']>;

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

/** Build an adapter whose stream + control URLs share a stable client id. */
function connect(server: SseServer, cid: string, opts: Partial<SseOptions> = {}) {
  return sse(() => `${server.base}/events?cid=${cid}`, {
    EventSource: ES,
    control: `${server.base}/control?cid=${cid}`,
    ...opts,
  });
}

let server: SseServer;

beforeEach(async () => {
  server = await SseServer.start();
});
afterEach(async () => {
  await server.close();
});

describe('sse · connect → subscribe → broadcast → unsubscribe', () => {
  it('delivers a normalized event, then stops after unsubscribe', async () => {
    const client = new LivefluxClient({ adapter: connect(server, 'c1') });
    client.connect();

    const feed = collect(client, 'orders');
    const fence = collect(client, 'fence');
    await waitUntil(() => server.subscribes().length === 2, { label: 'both subs registered' });

    server.broadcast('orders', 'created', { id: 7, status: 'new' });
    await waitUntil(() => feed.events.length === 1, { label: 'first order event' });
    expect(feed.events[0]).toEqual({
      channel: 'orders',
      event: 'created',
      payload: { id: 7, status: 'new' },
    });

    feed.sub.destroy();
    await waitUntil(
      () => server.controlFrames.some((f) => f.type === 'unsubscribe'),
      { label: 'unsubscribe frame received' },
    );

    // Broadcast on the now-unsubscribed channel, then a live fence — the fence arriving proves the
    // orders one would have too, had it not been unsubscribed.
    server.broadcast('orders', 'created', { id: 8 });
    server.broadcast('fence', 'ping', 1);
    await waitUntil(() => fence.events.length === 1, { label: 'fence event' });
    expect(feed.events).toHaveLength(1);

    client.destroy();
  });
});

describe('sse · reconnect replay', () => {
  it('re-opens a fresh stream, replays subs over the control channel, and resumes receiving', async () => {
    const client = new LivefluxClient({
      adapter: connect(server, 'c1'),
      reconnect: { baseMs: 20, jitter: 0 },
    });
    client.connect();

    const feed = collect(client, 'orders');
    await waitUntil(() => server.subscribes().length === 1, { label: 'initial subscribe' });
    server.broadcast('orders', 'created', { id: 1 });
    await waitUntil(() => feed.events.length === 1, { label: 'pre-drop event' });

    // Server abruptly ends the stream; the client backs off, re-opens, and replays.
    server.dropAll();
    await waitUntil(() => server.subscribes().length >= 2, { label: 'sub replayed on reconnect' });
    expect(server.subscribes().every((s) => s.channel === 'orders')).toBe(true);

    server.broadcast('orders', 'created', { id: 2 });
    await waitUntil(() => feed.events.length === 2, { label: 'post-reconnect event' });
    expect(feed.events.map((e) => e.payload)).toEqual([{ id: 1 }, { id: 2 }]);

    client.destroy();
  });
});

describe('sse · subscribe before open', () => {
  it('sends exactly one subscribe frame per subId when subscribing before the stream opens', async () => {
    const client = new LivefluxClient({ adapter: connect(server, 'c1') });
    client.connect();
    collect(client, 'orders'); // issued while the stream is still connecting

    await waitUntil(() => client.getConnectionState() === 'open', { label: 'stream open' });
    await waitUntil(() => server.subscribes().length >= 1, { label: 'replayed subscribe' });
    expect(server.subscribes().filter((s) => s.channel === 'orders')).toHaveLength(1);

    client.destroy();
  });
});

describe('sse · cursor from lastEventId', () => {
  it('threads the SSE id: field through as the event cursor when the payload omits one', async () => {
    const client = new LivefluxClient({ adapter: connect(server, 'c1') });
    client.connect();
    const feed = collect(client, 'orders');
    await waitUntil(() => server.subscribes().length === 1, { label: 'subscribed' });

    server.broadcast('orders', 'created', { id: 1 }, 'cursor-42');
    await waitUntil(() => feed.events.length === 1, { label: 'event with id' });
    expect(feed.events[0]).toEqual({
      channel: 'orders',
      event: 'created',
      payload: { id: 1 },
      cursor: 'cursor-42',
    });

    client.destroy();
  });
});

describe('sse · maxMessageBytes guard', () => {
  it('drops an oversized inbound frame before decoding, but delivers a small one', async () => {
    const client = new LivefluxClient({ adapter: connect(server, 'c1', { maxMessageBytes: 200 }) });
    client.connect();
    const feed = collect(client, 'orders');
    await waitUntil(() => server.subscribes().length === 1, { label: 'subscribed' });

    server.broadcast('orders', 'big', { blob: 'x'.repeat(500) }); // over the 200-byte cap → dropped
    server.broadcast('orders', 'small', { ok: true }); // fits → delivered
    await waitUntil(() => feed.events.length === 1, { label: 'small event delivered' });
    expect(feed.events[0]?.event).toBe('small');
    expect(feed.events).toHaveLength(1);

    client.destroy();
  });
});
