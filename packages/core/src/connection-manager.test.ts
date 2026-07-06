import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterHandlers, StreamAdapter } from './index';
import { ConnectionManager } from './connection-manager';

/** Minimal controllable adapter double for tests. */
class MockAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connectCalls = 0;
  disconnectCalls = 0;
  heartbeats = 0;

  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    this.connectCalls += 1;
  }
  disconnect(): void {
    this.disconnectCalls += 1;
  }
  subscribe(): void {}
  unsubscribe(): void {}
  heartbeat(): void {
    this.heartbeats += 1;
  }

  // test helpers
  open(): void {
    this.handlers?.onOpen();
  }
  drop(): void {
    this.handlers?.onClose();
  }
}

describe('ConnectionManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('transitions idle → connecting → open', () => {
    const adapter = new MockAdapter();
    const cm = new ConnectionManager({ adapter });
    const states: string[] = [];
    cm.onStateChange((s) => states.push(s));

    expect(cm.getState()).toBe('idle');
    cm.connect();
    expect(cm.getState()).toBe('connecting');
    adapter.open();
    expect(cm.getState()).toBe('open');
    expect(states).toEqual(['connecting', 'open']);
  });

  it('reconnects with backoff after an unexpected drop', () => {
    const adapter = new MockAdapter();
    const cm = new ConnectionManager({ adapter, random: () => 0.5 }); // neutral jitter
    cm.connect();
    adapter.open();
    expect(adapter.connectCalls).toBe(1);

    adapter.drop();
    expect(cm.getState()).toBe('reconnecting');

    vi.advanceTimersByTime(500); // first backoff = baseMs
    expect(adapter.connectCalls).toBe(2);
    adapter.open();
    expect(cm.getState()).toBe('open');
  });

  it('does NOT reconnect after a manual close', () => {
    const adapter = new MockAdapter();
    const cm = new ConnectionManager({ adapter });
    cm.connect();
    adapter.open();

    cm.close();
    expect(cm.getState()).toBe('closed');
    expect(adapter.disconnectCalls).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(adapter.connectCalls).toBe(1); // no reconnect
  });

  it('close() is idempotent — disconnects the adapter only once', () => {
    const adapter = new MockAdapter();
    const cm = new ConnectionManager({ adapter });
    cm.connect();
    adapter.open();

    cm.close();
    cm.close();
    cm.close();
    expect(adapter.disconnectCalls).toBe(1);
    expect(cm.getState()).toBe('closed');
  });

  it('gives up after maxAttempts', () => {
    const adapter = new MockAdapter();
    const cm = new ConnectionManager({ adapter, reconnect: { maxAttempts: 2 }, random: () => 0.5 });
    cm.connect();
    adapter.open();

    adapter.drop(); // attempt 1
    vi.advanceTimersByTime(500);
    adapter.drop(); // attempt 2
    vi.advanceTimersByTime(1000);
    adapter.drop(); // would be attempt 3 → exceeds max
    expect(cm.getState()).toBe('closed');
  });

  it('sends heartbeats while open, and stops after close', () => {
    const adapter = new MockAdapter();
    const cm = new ConnectionManager({ adapter, heartbeat: { enabled: true, intervalMs: 1000 } });
    cm.connect();
    adapter.open();

    vi.advanceTimersByTime(3000);
    expect(adapter.heartbeats).toBe(3);

    cm.close();
    vi.advanceTimersByTime(3000);
    expect(adapter.heartbeats).toBe(3); // stopped
  });
});
