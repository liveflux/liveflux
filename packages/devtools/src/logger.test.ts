import { describe, expect, it, vi } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '@liveflux/core';
import { attachLogger, type LogSink } from './logger';

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
  fail(err: unknown): void {
    this.handlers?.onError(err);
  }
}

interface Calls {
  error: unknown[][];
  warn: unknown[][];
  info: unknown[][];
  debug: unknown[][];
}

const fakeSink = (): LogSink & { calls: Calls } => {
  const calls: Calls = { error: [], warn: [], info: [], debug: [] };
  return {
    calls,
    error: (...a) => calls.error.push(a),
    warn: (...a) => calls.warn.push(a),
    info: (...a) => calls.info.push(a),
    debug: (...a) => calls.debug.push(a),
  };
};

describe('attachLogger', () => {
  it('silent wires nothing', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { level: 'silent', sink });
    client.connect();
    adapter.fail(new Error('x'));
    expect(sink.calls.error).toHaveLength(0);
    expect(sink.calls.info).toHaveLength(0);
  });

  it('error level logs failures but not lifecycle', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { level: 'error', sink });
    client.connect();
    adapter.fail(new Error('boom'));
    expect(sink.calls.error).toHaveLength(1);
    expect(sink.calls.info).toHaveLength(0);
  });

  it('info level logs connection and subscription lifecycle, not events', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { level: 'info', sink });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', { a: 1 });
    expect(sink.calls.info.length).toBeGreaterThanOrEqual(2); // connection + subscribe
    expect(sink.calls.debug).toHaveLength(0); // events are debug-level
  });

  it('debug level logs events with the payload redacted', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { level: 'debug', sink });
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', { token: 'secret', price: 1 });

    const eventLog = sink.calls.debug.find((args) => String(args[1]).startsWith('event'));
    expect(eventLog).toBeDefined();
    expect(eventLog!.at(-1)).toEqual({ token: '«redacted»', price: 1 });
  });

  it('the returned detach stops logging', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    const off = attachLogger(client, { level: 'debug', sink });
    off();
    client.connect();
    adapter.fail(new Error('x'));
    expect(sink.calls.error).toHaveLength(0);
    expect(sink.calls.info).toHaveLength(0);
  });

  it('defaults to the global console when no sink is given', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachLogger(client, { level: 'info' });
    client.connect();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
