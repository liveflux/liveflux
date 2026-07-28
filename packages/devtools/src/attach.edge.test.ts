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

const handleFor = (id: string) => [...getDevtoolsHook().clients].find((c) => c.id === id);

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY];
});

describe('attachDevtools — edge cases', () => {
  it('gives two attached clients distinct ids and separate buses', () => {
    attachDevtools(new LivefluxClient({ adapter: new MockAdapter() }));
    attachDevtools(new LivefluxClient({ adapter: new MockAdapter() }));
    const ids = [...getDevtoolsHook().clients].map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('honors a small bufferSize by evicting old events', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client, { bufferSize: 2 });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', 1);
    adapter.emit('trades', 2);
    const handle = [...getDevtoolsHook().clients][0]!;
    expect(handle.bus.getBuffer()).toHaveLength(2);
  });

  it('applies custom redactKeys', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client, { redactKeys: ['ssn'] });
    client.connect();
    client.subscribe({ channel: 'people', into: { strategy: 'append' } });
    adapter.emit('people', { ssn: '123', name: 'ann' });

    const handle = [...getDevtoolsHook().clients][0]!;
    const inbound = handle.bus.getBuffer().find((e: DevtoolsEvent) => e.t === 'event:in');
    expect((inbound as { payload: Record<string, unknown> }).payload).toEqual({
      ssn: '«redacted»',
      name: 'ann',
    });
  });

  it('preserves a non-plain payload (Date) end to end', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'ticks', into: { strategy: 'append' } });
    const when = new Date('2020-01-01T00:00:00Z');
    adapter.emit('ticks', when);

    const handle = [...getDevtoolsHook().clients][0]!;
    const inbound = handle.bus.getBuffer().find((e: DevtoolsEvent) => e.t === 'event:in');
    expect((inbound as { payload: unknown }).payload).toBe(when);
  });

  it('detach is idempotent — a double detach emits client:destroy once', () => {
    const client = new LivefluxClient({ adapter: new MockAdapter() });
    const detach = attachDevtools(client);
    const captured = [...getDevtoolsHook().clients][0]!;
    detach();
    detach();
    const destroys = captured.bus
      .getBuffer()
      .filter((e: DevtoolsEvent) => e.t === 'client:destroy');
    expect(destroys).toHaveLength(1);
    expect(getDevtoolsHook().clients.size).toBe(0);
  });

  it('after detach, no further events reach the bus', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const detach = attachDevtools(client);
    const captured = [...getDevtoolsHook().clients][0]!;
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    detach();
    const before = captured.bus.getBuffer().length;
    adapter.emit('trades', 1);
    expect(captured.bus.getBuffer().length).toBe(before);
  });
});
