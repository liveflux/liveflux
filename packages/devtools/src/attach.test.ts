import { beforeEach, describe, expect, it } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '@liveflux/core';
import { attachDevtools } from './attach';
import { DEVTOOLS_HOOK_KEY, getDevtoolsHook } from './hook';
import type { DevtoolsEvent } from './events';

class MockAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    handlers.onOpen();
  }
  disconnect(): void {}
  subscribe(_req: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}
  emit(channel: string, payload: unknown): void {
    this.handlers?.onEvent({ channel, event: 'update', payload });
  }
}

/** The single registered client's buffered events (fresh hook + one attachment per test). */
function buffer(): readonly DevtoolsEvent[] {
  const handle = [...getDevtoolsHook().clients][0];
  return handle ? handle.bus.getBuffer() : [];
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY];
});

describe('attachDevtools', () => {
  it('does not register anything until attached', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    expect(getDevtoolsHook().clients.size).toBe(0);
  });

  it('registers on the global hook and emits client:register', () => {
    attachDevtools(new LivefluxClient({ adapter: new MockAdapter() }));
    const clients = [...getDevtoolsHook().clients];
    expect(clients).toHaveLength(1);
    expect(clients[0]!.id).toMatch(/^client-\d+$/);
    expect(buffer().some((e) => e.t === 'client:register')).toBe(true);
  });

  it('emits connection:state transitions on connect', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    attachDevtools(client);
    client.connect();
    expect(buffer().some((e) => e.t === 'connection:state' && e.to === 'open')).toBe(true);
  });

  it('emits sub:add, ref-count changes, and sub:remove across shared subscriptions', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    attachDevtools(client);
    const a = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    const b = client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    const add = buffer().find((e) => e.t === 'sub:add');
    expect(add).toMatchObject({ t: 'sub:add', channel: 'trades', strategy: 'append', refCount: 1 });
    expect(buffer().some((e) => e.t === 'sub:refchange' && e.refCount === 2)).toBe(true);

    a.destroy();
    expect(buffer().some((e) => e.t === 'sub:refchange' && e.refCount === 1)).toBe(true);
    b.destroy();
    expect(buffer().some((e) => e.t === 'sub:remove')).toBe(true);
  });

  it('emits event:in with the payload redacted', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    adapter.emit('trades', { token: 'super-secret', price: 42 });
    const inbound = buffer().find((e) => e.t === 'event:in');
    expect(inbound).toMatchObject({ t: 'event:in', channel: 'trades' });
    expect((inbound as { payload: Record<string, unknown> }).payload).toEqual({
      token: '«redacted»',
      price: 42,
    });
  });

  it('detach emits client:destroy and deregisters', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const detach = attachDevtools(client);
    const captured = [...getDevtoolsHook().clients][0]!;
    detach();
    expect(getDevtoolsHook().clients.size).toBe(0);
    expect(captured.bus.getBuffer().some((e) => e.t === 'client:destroy')).toBe(true);
  });
});

/** A publish/request-capable adapter that can also deliver a correlated reply. */
class RpcAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    handlers.onOpen();
  }
  disconnect(): void {}
  subscribe(_req: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}
  publish(): void {}
  request(): void {}
  reply(requestId: string, ok: boolean, body: { payload?: unknown; error?: { message?: string; code?: string } }): void {
    this.handlers?.onReply?.({ requestId, ok, ...body });
  }
}

describe('attachDevtools — commands (publish / request)', () => {
  it('emits publish:out with the payload redacted and the queued flag', () => {
    const client = new LivefluxClient({ adapter: new RpcAdapter() });
    attachDevtools(client);
    client.connect();

    client.publish('orders', 'create', { token: 'super-secret', sku: 'A1' }, { idempotencyKey: 'k-1' });
    const out = buffer().find((e) => e.t === 'publish:out');
    expect(out).toMatchObject({
      t: 'publish:out',
      channel: 'orders',
      event: 'create',
      idempotencyKey: 'k-1',
      queued: false,
    });
    expect((out as { payload: Record<string, unknown> }).payload).toEqual({
      token: '«redacted»',
      sku: 'A1',
    });
  });

  it('emits request:out then request:settle(resolved) with a redacted reply payload', async () => {
    const adapter = new RpcAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();

    const p = client.request('orders', 'create', { sku: 'A1' });
    const out = buffer().find((e) => e.t === 'request:out');
    expect(out).toMatchObject({ t: 'request:out', requestId: 'req-1', channel: 'orders', event: 'create' });

    adapter.reply('req-1', true, { payload: { id: 7, token: 'leak' } });
    await expect(p).resolves.toEqual({ id: 7, token: 'leak' });
    const settle = buffer().find((e) => e.t === 'request:settle');
    expect(settle).toMatchObject({ t: 'request:settle', requestId: 'req-1', outcome: 'resolved' });
    expect((settle as { payload: Record<string, unknown> }).payload).toEqual({ id: 7, token: '«redacted»' });
  });

  it('emits request:settle(rejected) with a compact error description', async () => {
    const adapter = new RpcAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();

    const p = client.request('orders', 'create', {});
    adapter.reply('req-1', false, { error: { message: 'nope', code: 'BAD' } });
    await expect(p).rejects.toBeTruthy();
    const settle = buffer().find((e) => e.t === 'request:settle');
    expect(settle).toMatchObject({ t: 'request:settle', requestId: 'req-1', outcome: 'rejected' });
    expect((settle as { error: { code?: string } }).error).toMatchObject({ code: 'REQUEST_FAILED' });
  });
});
