import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/**
 * Detect the package manager to use. The one that launched us wins (npm sets
 * `npm_config_user_agent` for every PM), then the project's lockfile, then npm.
 */
export function detectPackageManager(dir: string): PackageManager {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  if (ua.startsWith('npm')) return 'npm';

  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** The command + args that install runtime dependencies for a given PM. */
export function addCommand(pm: PackageManager, packages: readonly string[]): { command: string; args: string[] } {
  const verb = pm === 'npm' ? 'install' : 'add';
  return { command: pm, args: [verb, ...packages] };
}
