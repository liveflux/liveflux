import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVTOOLS_HOOK_KEY, getDevtoolsHook, type ClientHandle } from './hook';
import { ObservabilityBus } from './bus';

const handle = (id: string): ClientHandle => ({
  id,
  bus: new ObservabilityBus(),
  meta: { createdAt: 0 },
});

beforeEach(() => {
  // Fresh global hook per test — it lives on globalThis and would otherwise leak across tests.
  delete (globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY];
});

describe('getDevtoolsHook', () => {
  it('is a lazily-created singleton', () => {
    const a = getDevtoolsHook();
    const b = getDevtoolsHook();
    expect(a).toBe(b);
    expect(a.version).toBe(1);
    expect((globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY]).toBe(a);
  });

  it('register / deregister update the client set', () => {
    const hook = getDevtoolsHook();
    const h = handle('client-1');
    hook.register(h);
    expect(hook.clients.has(h)).toBe(true);
    hook.deregister(h);
    expect(hook.clients.has(h)).toBe(false);
  });

  it('notifies subscribers with the full list on register and deregister', () => {
    const hook = getDevtoolsHook();
    const listener = vi.fn();
    hook.subscribe(listener);
    const h = handle('client-1');
    hook.register(h);
    expect(listener).toHaveBeenLastCalledWith([h]);
    hook.deregister(h);
    expect(listener).toHaveBeenLastCalledWith([]);
  });

  it('deregistering an unknown handle does not notify', () => {
    const hook = getDevtoolsHook();
    const listener = vi.fn();
    hook.subscribe(listener);
    hook.deregister(handle('ghost'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const hook = getDevtoolsHook();
    const listener = vi.fn();
    const off = hook.subscribe(listener);
    off();
    hook.register(handle('client-1'));
    expect(listener).not.toHaveBeenCalled();
  });
});
