import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { NormalizedEvent } from '@liveflux/core';
import { phoenix } from '@liveflux/phoenix';
import { PhoenixClientCtor } from '../support/node-ws';
import { PhoenixServer } from '../support/phoenix-server';
import { waitUntil } from '../support/async';

/**
 * Layer-3 integration — `@liveflux/phoenix` + `@liveflux/core` over a **real** in-process Phoenix
 * Channels v2 server. Exercises join / broadcast / leave, reconnect re-join, the `phx_error` →
 * transparent-rejoin path, dynamic-param re-auth, the keepalive round-trip, and a rejected join
 * surfacing through `onError` — all over a genuine socket with bounded waits.
 */

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

/** Recover the `subId` from a composite `join_ref` `` `${subId}#${instance}` ``. */
function subIdOf(joinRef: string): string {
  const i = joinRef.lastIndexOf('#');
  return i < 0 ? joinRef : joinRef.slice(0, i);
}

let server: PhoenixServer;

beforeEach(async () => {
  server = await PhoenixServer.start();
});
afterEach(async () => {
  await server.close();
});

describe('phoenix · join → broadcast → leave', () => {
  it('joins a topic, receives a broadcast, and leaves on unsubscribe', async () => {
    const adapter = phoenix(server.url(), { WebSocket: PhoenixClientCtor });
    const client = new LivefluxClient({ adapter });
    client.connect();

    const feed = collect(client, 'room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) === 1, { label: 'join accepted' });
    expect(server.latest?.joins[0]?.topic).toBe('room:lobby');

    server.broadcast('room:lobby', 'msg', { text: 'hello' });
    await waitUntil(() => feed.events.length === 1, { label: 'broadcast received' });
    expect(feed.events[0]).toEqual({ channel: 'room:lobby', event: 'msg', payload: { text: 'hello' } });

    feed.sub.destroy();
    await waitUntil(() => (server.latest?.leaves.length ?? 0) === 1, { label: 'leave sent' });
    expect(server.latest?.leaves).toContain('room:lobby');

    client.destroy();
  });
});

describe('phoenix · reconnect re-join', () => {
  it('re-joins active topics on a fresh connection after a server drop', async () => {
    const adapter = phoenix(server.url(), { WebSocket: PhoenixClientCtor });
    const client = new LivefluxClient({ adapter, reconnect: { baseMs: 20, jitter: 0 } });
    client.connect();

    const feed = collect(client, 'room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) === 1, { label: 'first join' });
    server.broadcast('room:lobby', 'msg', 1);
    await waitUntil(() => feed.events.length === 1, { label: 'pre-drop event' });

    server.dropAll();
    await waitUntil(() => server.connections.length >= 2, { label: 'reconnected' });
    await waitUntil(
      () => server.latest?.joins.some((j) => j.topic === 'room:lobby') === true,
      { label: 're-joined on reconnect' },
    );

    server.broadcast('room:lobby', 'msg', 2);
    await waitUntil(() => feed.events.length === 2, { label: 'post-reconnect event' });
    expect(feed.events.map((e) => e.payload)).toEqual([1, 2]);

    client.destroy();
  });
});

describe('phoenix · phx_error → transparent rejoin', () => {
  it('re-joins a crashed channel and surfaces the error for observability', async () => {
    const adapter = phoenix(server.url(), {
      WebSocket: PhoenixClientCtor,
      rejoinDelayMs: 20,
    });
    const client = new LivefluxClient({ adapter });
    const errors: unknown[] = [];
    client.onError((e) => errors.push(e));
    client.connect();

    const feed = collect(client, 'room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) === 1, { label: 'initial join' });

    // Server crashes the channel. The adapter surfaces a channel_error and transparently re-joins
    // (same socket, capped backoff), without the core ever calling subscribe again.
    server.emitChannelError('room:lobby');
    await waitUntil(
      () => (server.latest?.joins.filter((j) => j.topic === 'room:lobby').length ?? 0) >= 2,
      { label: 'transparent re-join' },
    );
    expect(errors).toContainEqual({ type: 'channel_error', channel: 'room:lobby' });

    // The re-joined channel still delivers.
    server.broadcast('room:lobby', 'msg', 'back');
    await waitUntil(() => feed.events.length === 1, { label: 'post-rejoin delivery' });
    expect(feed.events[0]?.payload).toBe('back');

    client.destroy();
  });
});

describe('phoenix · dynamic params re-auth', () => {
  it('re-invokes the params function on each connect so a rotated token reaches the server', async () => {
    let n = 0;
    const adapter = phoenix(server.url(), {
      WebSocket: PhoenixClientCtor,
      params: () => ({ token: String(++n) }),
    });
    const client = new LivefluxClient({ adapter, reconnect: { baseMs: 20, jitter: 0 } });
    client.connect();
    collect(client, 'room:lobby');

    await waitUntil(() => (server.latest?.joins.length ?? 0) === 1, { label: 'first connect + join' });
    expect(server.connections[0]?.query).toContain('token=1');
    expect(server.connections[0]?.query).toContain('vsn=2.0.0');

    server.dropAll();
    await waitUntil(() => server.connections.length >= 2, { label: 'reconnect' });
    expect(server.connections[1]?.query).toContain('token=2');

    client.destroy();
  });
});

describe('phoenix · heartbeat round-trip', () => {
  it('sends keepalives the server acks, keeping the single socket alive', async () => {
    const adapter = phoenix(server.url(), { WebSocket: PhoenixClientCtor });
    const client = new LivefluxClient({
      adapter,
      heartbeat: { enabled: true, intervalMs: 15 },
    });
    client.connect();
    collect(client, 'room:lobby');

    await waitUntil(() => (server.latest?.heartbeats ?? 0) >= 2, { label: 'heartbeats acked' });
    // Acks cleared the outstanding ref each tick, so the dead-link guard never fired → still one socket.
    expect(server.connections).toHaveLength(1);
    expect(client.getConnectionState()).toBe('open');

    client.destroy();
  });
});

describe('phoenix · missed heartbeat → zombie close → reconnect', () => {
  it('closes the dead-link socket and reconnects + re-joins when the server stops acking heartbeats', async () => {
    const adapter = phoenix(server.url(), { WebSocket: PhoenixClientCtor, rejoinDelayMs: 20 });
    const client = new LivefluxClient({
      adapter,
      reconnect: { baseMs: 20, jitter: 0 },
      // A short interval makes the "previous heartbeat unacked by the next tick" guard fire fast.
      heartbeat: { enabled: true, intervalMs: 25 },
    });
    client.connect();

    const feed = collect(client, 'room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) === 1, { label: 'initial join' });
    const first = server.latest!;

    // Server goes silent on heartbeats: the client's outstanding keepalive is never acked, so its
    // next tick detects the dead link and closes the zombie socket (fires onClose → core reconnects).
    server.setAckHeartbeats(false);
    await waitUntil(() => first.socket.readyState >= 2 /* CLOSING|CLOSED */, {
      label: 'zombie socket closed by the client',
    });
    // Resume acking so the fresh socket is not immediately reaped too, letting recovery settle.
    server.setAckHeartbeats(true);

    await waitUntil(() => server.connections.length >= 2, { label: 'core reconnected (fresh socket)' });
    await waitUntil(() => server.latest!.joins.some((j) => j.topic === 'room:lobby'), {
      label: 're-joined on the fresh socket',
    });

    // Full recovery: a broadcast on the reconnected socket reaches the same, still-live fold.
    server.broadcast('room:lobby', 'msg', 'after-zombie');
    await waitUntil(() => feed.events.some((e) => e.payload === 'after-zombie'), {
      label: 'post-reconnect delivery',
    });

    client.destroy();
  });
});

describe('phoenix · per-join timeout retry', () => {
  it('retries a join with a fresh instance when the server never replies to phx_join', async () => {
    server.setReplyToJoins(false); // the socket opens, but a phx_join is never answered
    const adapter = phoenix(server.url(), {
      WebSocket: PhoenixClientCtor,
      joinTimeoutMs: 40,
      rejoinDelayMs: 20,
    });
    const client = new LivefluxClient({ adapter });
    client.connect();

    collect(client, 'room:lobby');
    // The first join lands but is left unanswered; the per-join timeout then retries with a fresh
    // join instance (capped backoff) — which the silent server also records on the wire.
    await waitUntil(
      () => (server.latest?.joins.filter((j) => j.topic === 'room:lobby').length ?? 0) >= 2,
      { label: 'join retried after the timeout' },
    );
    const refs = server
      .latest!.joins.filter((j) => j.topic === 'room:lobby')
      .map((j) => j.joinRef);
    // Same subscription, distinct successive instances — never a duplicate of the timed-out join_ref.
    expect(subIdOf(refs[0]!)).toBe(subIdOf(refs[1]!));
    expect(refs[0]).not.toBe(refs[1]);

    client.destroy();
  });
});

describe('phoenix · stale join_ref filtering', () => {
  it('ignores a phx_error carrying a superseded join_ref (no extra error, no extra re-join)', async () => {
    const adapter = phoenix(server.url(), { WebSocket: PhoenixClientCtor, rejoinDelayMs: 20 });
    const client = new LivefluxClient({ adapter });
    const errors: unknown[] = [];
    client.onError((e) => errors.push(e));
    client.connect();

    const feed = collect(client, 'room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) === 1, { label: 'initial join' });
    const stale = server.latest!.joins[0]!.joinRef; // the instance about to be superseded

    // Crash the channel → exactly one channel_error + a transparent re-join minting a fresh instance.
    server.emitChannelError('room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) >= 2, { label: 'transparent re-join' });
    await waitUntil(() => errors.length === 1, { label: 'single channel_error surfaced' });

    // A late phx_error from the crashed (now-superseded) instance must be dropped.
    server.sendToLatest(stale, null, 'room:lobby', 'phx_error', {});
    // Fence: a normal broadcast ordered after the stale frame on the same socket — its delivery
    // proves the stale frame was already processed (and ignored), not merely still in flight.
    server.broadcast('room:lobby', 'msg', 'fence');
    await waitUntil(() => feed.events.some((e) => e.payload === 'fence'), { label: 'fence delivered' });

    expect(errors).toHaveLength(1); // the stale phx_error raised no second channel_error
    expect(server.latest!.joins.filter((j) => j.topic === 'room:lobby')).toHaveLength(2); // no 3rd join
    client.destroy();
  });

  it('ignores a phx_reply for an in-flight join whose join_ref was superseded', async () => {
    server.setReplyToJoins(false); // leave join #1 pending (its reply never comes)
    const adapter = phoenix(server.url(), { WebSocket: PhoenixClientCtor, rejoinDelayMs: 20 });
    const client = new LivefluxClient({ adapter });
    const errors: unknown[] = [];
    client.onError((e) => errors.push(e));
    client.connect();

    const feed = collect(client, 'room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) === 1, {
      label: 'initial (unanswered) join',
    });
    const pending = server.latest!.joins[0]!; // still awaiting its reply (ref never answered)

    // Crash the channel → channel_error + a re-join that supersedes the still-pending join #1.
    server.emitChannelError('room:lobby');
    await waitUntil(() => (server.latest?.joins.length ?? 0) >= 2, { label: 're-join minted' });
    await waitUntil(() => errors.length === 1, { label: 'channel_error surfaced' });

    // A late *error* reply for the still-pending join #1 arrives; its join_ref is no longer current,
    // so the adapter clears the pending entry but does NOT surface a join_error.
    server.sendToLatest(pending.joinRef, pending.ref, 'room:lobby', 'phx_reply', {
      status: 'error',
      response: {},
    });
    server.broadcast('room:lobby', 'msg', 'fence');
    await waitUntil(() => feed.events.some((e) => e.payload === 'fence'), { label: 'fence delivered' });

    expect(errors).toHaveLength(1); // only the channel_error — the stale error reply was ignored
    expect(errors[0]).toMatchObject({ type: 'channel_error', channel: 'room:lobby' });
    client.destroy();
  });
});

describe('phoenix · rejected join → onError', () => {
  it('surfaces a join_error when the server replies with status:error', async () => {
    server.rejectTopic('secure:vault');
    const adapter = phoenix(server.url(), { WebSocket: PhoenixClientCtor });
    const client = new LivefluxClient({ adapter });
    const errors: unknown[] = [];
    client.onError((e) => errors.push(e));
    client.connect();

    collect(client, 'secure:vault');
    await waitUntil(() => errors.length >= 1, { label: 'join_error surfaced' });
    expect(errors[0]).toMatchObject({ type: 'join_error', channel: 'secure:vault' });

    client.destroy();
  });
});
