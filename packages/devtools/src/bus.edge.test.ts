import { describe, expect, it, vi } from 'vitest';
import { ObservabilityBus } from './bus';
import type { DevtoolsEvent } from './events';

const ev = (id: string): DevtoolsEvent => ({ t: 'client:register', clientId: id, at: 0 });

describe('ObservabilityBus — edge cases', () => {
  it('floors an invalid cap to at least 1', () => {
    for (const cap of [0, -5, 0.9]) {
      const bus = new ObservabilityBus(cap);
      bus.emit(ev('a'));
      bus.emit(ev('b'));
      expect(bus.getBuffer()).toHaveLength(1);
      expect(bus.getBuffer()[0]).toMatchObject({ clientId: 'b' });
    }
  });

  it('getBuffer returns an independent copy (mutating it never touches the bus)', () => {
    const bus = new ObservabilityBus();
    bus.emit(ev('a'));
    const snapshot = bus.getBuffer() as DevtoolsEvent[];
    snapshot.push(ev('injected'));
    expect(bus.getBuffer()).toHaveLength(1);
  });

  it('tolerates a listener that unsubscribes itself mid-emit', () => {
    const bus = new ObservabilityBus();
    const other = vi.fn();
    const off = bus.subscribe(() => off());
    bus.subscribe(other);
    expect(() => bus.emit(ev('a'))).not.toThrow();
    expect(other).toHaveBeenCalledOnce();
    // The self-removed listener no longer fires.
    other.mockClear();
    bus.emit(ev('b'));
    expect(other).toHaveBeenCalledOnce();
  });

  it('tolerates a listener that subscribes another mid-emit', () => {
    const bus = new ObservabilityBus();
    const added = vi.fn();
    bus.subscribe(() => {
      bus.subscribe(added);
    });
    expect(() => bus.emit(ev('a'))).not.toThrow();
    bus.emit(ev('b'));
    expect(added).toHaveBeenCalled();
  });
});
