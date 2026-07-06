import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, SubscribeRequest } from '../../types';
import { SubscriptionRegistry } from './subscription-registry';

class MockWire {
  subscribed: SubscribeRequest[] = [];
  unsubscribed: string[] = [];
  subscribe(req: SubscribeRequest): void {
    this.subscribed.push(req);
  }
  unsubscribe(subId: string): void {
    this.unsubscribed.push(subId);
  }
}

const evt = (channel: string, payload: unknown = {}): NormalizedEvent => ({
  channel,
  event: 'update',
  payload,
});

describe('SubscriptionRegistry', () => {
  it('opens a wire subscription for the first listener on a channel', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    reg.subscribe('trades', () => {});
    expect(wire.subscribed).toHaveLength(1);
    expect(wire.subscribed[0]?.channel).toBe('trades');
    expect(reg.size).toBe(1);
  });

  it('multiplexes — extra listeners on the same channel do not re-subscribe on the wire', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    reg.subscribe('trades', () => {});
    reg.subscribe('trades', () => {});
    expect(wire.subscribed).toHaveLength(1);
    expect(reg.size).toBe(1);
  });

  it('fans an event out to every listener on its channel only', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    reg.subscribe('trades', a);
    reg.subscribe('trades', b);
    reg.subscribe('quotes', other);

    const e = evt('trades', { id: 1 });
    reg.handleEvent(e);

    expect(a).toHaveBeenCalledWith(e);
    expect(b).toHaveBeenCalledWith(e);
    expect(other).not.toHaveBeenCalled();
  });

  it('keeps the wire subscription while other listeners remain', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    const off1 = reg.subscribe('trades', () => {});
    const stay = vi.fn();
    reg.subscribe('trades', stay);

    off1();
    expect(wire.unsubscribed).toHaveLength(0);
    reg.handleEvent(evt('trades'));
    expect(stay).toHaveBeenCalledTimes(1);
  });

  it('tears down the wire subscription when the last listener leaves', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    const off = reg.subscribe('trades', () => {});
    off();
    expect(wire.unsubscribed).toEqual([wire.subscribed[0]?.subId]);
    expect(reg.size).toBe(0);
  });

  it('unsubscribe is idempotent', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    const off = reg.subscribe('trades', () => {});
    off();
    off();
    off();
    expect(wire.unsubscribed).toHaveLength(1);
  });

  it('ignores events for channels with no subscribers', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    expect(() => reg.handleEvent(evt('ghost'))).not.toThrow();
  });

  it('clear() tears down every wire subscription', () => {
    const wire = new MockWire();
    const reg = new SubscriptionRegistry(wire);
    reg.subscribe('a', () => {});
    reg.subscribe('b', () => {});
    reg.clear();
    expect(wire.unsubscribed).toHaveLength(2);
    expect(reg.size).toBe(0);
  });
});
