import { ADAPTERS, CORE_PKG, FRAMEWORKS, byId } from './registry';

/** A fully resolved set of choices — every field decided, never defaulted. */
export interface Selection {
  readonly framework: string;
  readonly adapter: string;
  readonly typescript: boolean;
}

/**
 * The npm packages to install for a selection. `@liveflux/core` is always
 * included; the adapter and (unless vanilla) the framework binding are added
 * from the registry, so this can never resolve a `soon` package.
 */
export function packagesFor(selection: Selection): string[] {
  const packages = [CORE_PKG];
  const adapter = byId(ADAPTERS, selection.adapter);
  if (adapter?.pkg) packages.push(adapter.pkg);
  const framework = byId(FRAMEWORKS, selection.framework);
  if (framework?.pkg) packages.push(framework.pkg);
  return packages;
}
