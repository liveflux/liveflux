import { describe, expect, it } from 'vitest';
import type { AdapterHandlers, NormalizedEvent } from '@liveflux/core';
import { MockAdapter } from './mock-adapter';
import { type AdapterHarness, runAdapterConformance } from './conformance';

function silentHandlers(overrides: Partial<AdapterHandlers> = {}): AdapterHandlers {
  return {
    onOpen() {},
    onClose() {},
    onError() {},
    onEvent() {},
    ...overrides,
  };
}

describe('MockAdapter', () => {
  it('captures the handlers on connect and reports connection state', () => {
    const adapter = new MockAdapter();
    expect(adapter.handlers).toBeNull();
    expect(adapter.connected).toBe(false);

    const handlers = silentHandlers();
    adapter.connect(handlers);
    expect(adapter.handlers).toBe(handlers);
    expect(adapter.connected).toBe(false); // connected only once open() completes the handshake

    adapter.open();
    expect(adapter.connected).toBe(true);
  });

  it('fires lifecycle callbacks synchronously', () => {
    const seen: string[] = [];
    const adapter = new MockAdapter();
    adapter.connect(
      silentHandlers({
        onOpen: () => seen.push('open'),
        onError: () => seen.push('error'),
        onClose: () => seen.push('close'),
      }),
    );
    adapter.open();
    adapter.fail(new Error('boom'));
    adapter.drop('bye');
    expect(seen).toEqual(['open', 'error', 'close']);
  });

  it('delivers emitted events only while open', () => {
    const events: NormalizedEvent[] = [];
    const adapter = new MockAdapter();
    adapter.connect(silentHandlers({ onEvent: (e) => events.push(e) }));
    adapter.subscribe({ subId: 's1', channel: 'orders' });

    const before: NormalizedEvent = { channel: 'orders', event: 'update', payload: 0 };
    adapter.emit(before); // not open yet → dropped
    expect(events).toEqual([]);

    adapter.open();
    const after: NormalizedEvent = { channel: 'orders', event: 'update', payload: 1 };
    adapter.emit(after);
    expect(events).toEqual([after]);
  });

  it('tracks the active set, the wire log, and per-sub cursors', () => {
    const adapter = new MockAdapter();
    adapter.connect(silentHandlers());
    adapter.open();
    adapter.subscribe({ subId: 's1', channel: 'orders' });
    adapter.subscribe({ subId: 's2', channel: 'trades' });

    expect(adapter.subscriptions.map((s) => s.subId)).toEqual(['s1', 's2']);
    expect(adapter.subscribeLog).toHaveLength(2);

    adapter.emit({ channel: 'orders', event: 'update', payload: 1, cursor: 'c-10' });
    expect(adapter.lastCursor('s1')).toBe('c-10');
    expect(adapter.lastCursor('s2')).toBeNull();

    adapter.unsubscribe('s1');
    expect(adapter.unsubscribeLog).toEqual(['s1']);
    expect(adapter.subscriptions.map((s) => s.subId)).toEqual(['s2']);
    expect(adapter.lastCursor('s1')).toBeNull(); // cursor forgotten with the subscription
  });

  it('replays the active set on reconnect but not unsubscribed subs', () => {
    const adapter = new MockAdapter();
    adapter.connect(silentHandlers());
    adapter.open();
    adapter.subscribe({ subId: 's1', channel: 'orders' });
    adapter.subscribe({ subId: 's2', channel: 'trades' });
    adapter.unsubscribe('s2');

    adapter.drop();
    adapter.connect(silentHandlers());
    adapter.open(); // replays the active set (s1 only)

    const replayed = adapter.subscribeLog.slice(2); // frames sent after the two originals
    expect(replayed.map((s) => s.subId)).toEqual(['s1']);
  });

  it('records resume calls and counts heartbeats', () => {
    const adapter = new MockAdapter();
    adapter.connect(silentHandlers());
    adapter.open();
    adapter.resume('s1', 'c-1');
    adapter.resume('s1', null);
    adapter.heartbeat();
    adapter.heartbeat();
    expect(adapter.resumeLog).toEqual([
      { subId: 's1', cursor: 'c-1' },
      { subId: 's1', cursor: null },
    ]);
    expect(adapter.heartbeats).toBe(2);
  });

  it('throws a clear error if the control surface is used before any connect', () => {
    const adapter = new MockAdapter();
    expect(() => adapter.open()).toThrow(/before connect/);
    expect(() => adapter.emit({ channel: 'orders', event: 'x', payload: 1 })).toThrow(
      /before connect/,
    );
  });

  it('silently ignores late server activity after disconnect', () => {
    const events: NormalizedEvent[] = [];
    let closes = 0;
    const adapter = new MockAdapter();
    adapter.connect(silentHandlers({ onEvent: (e) => events.push(e), onClose: () => (closes += 1) }));
    adapter.open();
    adapter.subscribe({ subId: 's1', channel: 'orders' });
    adapter.disconnect();
    expect(adapter.handlers).toBeNull();

    // A late frame on a dead connection is dropped, not an error (mirrors a retired real socket).
    expect(() => adapter.emit({ channel: 'orders', event: 'x', payload: 1 })).not.toThrow();
    adapter.drop();
    expect(events).toEqual([]);
    expect(closes).toBe(0);
  });

  it('does not leak internal state through the introspection getters', () => {
    const adapter = new MockAdapter();
    adapter.connect(silentHandlers());
    adapter.open();
    adapter.subscribe({ subId: 's1', channel: 'orders' });
    (adapter.subscriptions as unknown[]).length = 0; // mutate the returned copy
    (adapter.subscribeLog as unknown[]).length = 0;
    expect(adapter.subscriptions).toHaveLength(1); // internal state untouched
    expect(adapter.subscribeLog).toHaveLength(1);
  });
});

// The suite is coherent and self-consistent: MockAdapter is itself a StreamAdapter, so it must pass
// the very contract it helps prove. This doubles as living documentation of a harness.
runAdapterConformance({
  name: 'MockAdapter (self-check)',
  setup(): AdapterHarness {
    const adapter = new MockAdapter();
    return {
      adapter,
      open: () => adapter.open(),
      emit: (event) => adapter.emit(event),
      drop: (reason) => adapter.drop(reason),
      sentSubscribes: () => adapter.subscribeLog,
      sentUnsubscribes: () => adapter.unsubscribeLog,
      sentResumes: () => adapter.resumeLog,
    };
  },
});
