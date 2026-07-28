import { describe, expect, it } from 'vitest';
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

describe('attachLogger — edge cases', () => {
  it('warn level logs errors but not info-level lifecycle', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { level: 'warn', sink });
    client.connect(); // info-level
    adapter.fail(new Error('x')); // error-level
    expect(sink.calls.error).toHaveLength(1);
    expect(sink.calls.info).toHaveLength(0);
  });

  it('defaults to info level when none is given', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { sink });
    client.connect();
    expect(sink.calls.info.length).toBeGreaterThan(0);
  });

  it('uses a custom prefix', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { level: 'info', sink, prefix: '<lf>' });
    client.connect();
    expect(sink.calls.info[0]![0]).toBe('<lf>');
  });

  it('applies custom redactKeys to debug-level event logs', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    const sink = fakeSink();
    attachLogger(client, { level: 'debug', sink, redactKeys: ['ssn'] });
    client.connect();
    client.subscribe({ channel: 'people', into: { strategy: 'append' } });
    adapter.emit('people', { ssn: '123', ok: 1 });

    const eventLog = sink.calls.debug.find((args) => String(args[1]).startsWith('event'));
    expect(eventLog!.at(-1)).toEqual({ ssn: '«redacted»', ok: 1 });
  });
});
