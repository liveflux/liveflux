import { describe, expect, it, vi } from 'vitest';
import { ObservabilityBus } from './bus';
import type { DevtoolsEvent } from './events';

const ev = (id: string): DevtoolsEvent => ({ t: 'client:register', clientId: id, at: 0 });

describe('ObservabilityBus', () => {
  it('notifies live listeners on emit', () => {
    const bus = new ObservabilityBus();
    const seen: DevtoolsEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.emit(ev('a'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ clientId: 'a' });
  });

  it('buffers history for late attach, oldest first', () => {
    const bus = new ObservabilityBus();
    bus.emit(ev('a'));
    bus.emit(ev('b'));
    expect(bus.getBuffer().map((e) => (e as { clientId: string }).clientId)).toEqual(['a', 'b']);
  });

  it('bounds the buffer by cap, evicting the oldest', () => {
    const bus = new ObservabilityBus(2);
    bus.emit(ev('a'));
    bus.emit(ev('b'));
    bus.emit(ev('c'));
    expect(bus.getBuffer().map((e) => (e as { clientId: string }).clientId)).toEqual(['b', 'c']);
  });

  it('does not replay history to a new subscriber', () => {
    const bus = new ObservabilityBus();
    bus.emit(ev('a'));
    const late = vi.fn();
    bus.subscribe(late);
    expect(late).not.toHaveBeenCalled();
    bus.emit(ev('b'));
    expect(late).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops delivery', () => {
    const bus = new ObservabilityBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    off();
    bus.emit(ev('a'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener from the others and the caller', () => {
    const bus = new ObservabilityBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('bad observer');
    });
    bus.subscribe(good);
    expect(() => bus.emit(ev('a'))).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('clear empties the buffer but keeps listeners', () => {
    const bus = new ObservabilityBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.emit(ev('a'));
    bus.clear();
    expect(bus.getBuffer()).toHaveLength(0);
    bus.emit(ev('b'));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
