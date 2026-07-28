import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '@liveflux/core';
import { attachDevtools } from './attach';
import { DEVTOOLS_HOOK_KEY, getDevtoolsHook } from './hook';
import { DevtoolsModel } from './view-model';

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

const flush = () => Promise.resolve();

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY];
});

describe('DevtoolsModel — integration with the hook + a live client', () => {
  it('discovers a client attached BEFORE the model and replays its history', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    const model = new DevtoolsModel();
    const state = model.getState();
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.connectionState).toBe('open');
    expect(state.clients[0]!.subscriptions[0]).toMatchObject({ channel: 'trades' });
    model.destroy();
  });

  it('discovers a client attached AFTER the model, live', () => {
    const model = new DevtoolsModel();
    expect(model.getState().clients).toHaveLength(0);

    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', { a: 1 });
    adapter.emit('trades', { a: 2 });

    const state = model.getState();
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.eventCount).toBeGreaterThanOrEqual(1);
    model.destroy();
  });

  it('coalesces change notifications to one per microtask', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    const model = new DevtoolsModel();
    const listener = vi.fn();
    model.subscribe(listener);

    adapter.emit('trades', 1);
    adapter.emit('trades', 2);
    adapter.emit('trades', 3);
    expect(listener).not.toHaveBeenCalled(); // deferred
    await flush();
    expect(listener).toHaveBeenCalledTimes(1); // coalesced burst → single notify
    model.destroy();
  });

  it('marks a client gone (but keeps its view) when it detaches', async () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const detach = attachDevtools(client);
    const model = new DevtoolsModel();
    expect(model.getState().clients[0]!.present).toBe(true);

    detach();
    await flush();
    const state = model.getState();
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.present).toBe(false);
    model.destroy();
  });

  it('stops updating after destroy', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });

    const model = new DevtoolsModel();
    const before = model.getState().clients[0]!.eventCount;
    const listener = vi.fn();
    model.subscribe(listener);
    model.destroy();

    adapter.emit('trades', 1);
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(model.getState().clients[0]!.eventCount).toBe(before);
  });

  it('tracks two clients independently', () => {
    const a = new LivefluxClient({ adapter: new MockAdapter() });
    const b = new LivefluxClient({ adapter: new MockAdapter() });
    attachDevtools(a);
    attachDevtools(b);
    a.connect();
    const model = new DevtoolsModel();
    const states = model.getState().clients;
    expect(states).toHaveLength(2);
    const open = states.filter((c) => c.connectionState === 'open');
    expect(open).toHaveLength(1); // only `a` connected
    model.destroy();
  });
});
