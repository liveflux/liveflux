import { describe, expect, it } from 'vitest';
import { ADAPTERS, FRAMEWORKS, byId, soon, stable } from './registry';

describe('registry — source of truth', () => {
  it('has unique ids within each group', () => {
    const frameworkIds = FRAMEWORKS.map((c) => c.id);
    const adapterIds = ADAPTERS.map((c) => c.id);
    expect(new Set(frameworkIds).size).toBe(frameworkIds.length);
    expect(new Set(adapterIds).size).toBe(adapterIds.length);
  });

  it('every stable adapter is installable (pkg + importName)', () => {
    for (const adapter of stable(ADAPTERS)) {
      expect(adapter.pkg, adapter.id).toBeTruthy();
      expect(adapter.importName, adapter.id).toBeTruthy();
    }
  });

  it('no coming-soon choice is installable (never carries a package)', () => {
    for (const choice of [...soon(FRAMEWORKS), ...soon(ADAPTERS)]) {
      expect(choice.pkg, choice.id).toBeUndefined();
    }
  });

  it('stable and soon partition every choice', () => {
    expect(stable(ADAPTERS).length + soon(ADAPTERS).length).toBe(ADAPTERS.length);
    expect(stable(FRAMEWORKS).length + soon(FRAMEWORKS).length).toBe(FRAMEWORKS.length);
  });

  it('offers at least one stable framework and adapter', () => {
    expect(stable(FRAMEWORKS).length).toBeGreaterThan(0);
    expect(stable(ADAPTERS).length).toBeGreaterThan(0);
  });

  it('byId finds a known id and misses an unknown one', () => {
    expect(byId(ADAPTERS, 'ws')?.id).toBe('ws');
    expect(byId(ADAPTERS, 'nope')).toBeUndefined();
  });
});
