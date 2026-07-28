import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVTOOLS_HOOK_KEY, getDevtoolsHook, type ClientHandle } from './hook';
import { ObservabilityBus } from './bus';

const handle = (id: string): ClientHandle => ({
  id,
  bus: new ObservabilityBus(),
  meta: { createdAt: 0 },
});

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY];
});

describe('getDevtoolsHook — edge cases', () => {
  it('registering the same handle twice keeps a single entry', () => {
    const hook = getDevtoolsHook();
    const h = handle('client-1');
    hook.register(h);
    hook.register(h);
    expect(hook.clients.size).toBe(1);
  });

  it('isolates a throwing hook subscriber from the others and from register', () => {
    const hook = getDevtoolsHook();
    const good = vi.fn();
    hook.subscribe(() => {
      throw new Error('bad hook listener');
    });
    hook.subscribe(good);
    expect(() => hook.register(handle('client-1'))).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('exposes the live client set to a panel (reflects later changes)', () => {
    const hook = getDevtoolsHook();
    const view = hook.clients; // a panel would hold this reference
    const h = handle('client-1');
    hook.register(h);
    expect(view.has(h)).toBe(true);
    hook.deregister(h);
    expect(view.has(h)).toBe(false);
  });

  it('supports several concurrent clients', () => {
    const hook = getDevtoolsHook();
    const a = handle('a');
    const b = handle('b');
    hook.register(a);
    hook.register(b);
    expect(hook.clients.size).toBe(2);
    expect([...hook.clients].map((c) => c.id).sort()).toEqual(['a', 'b']);
  });
});
