import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface FileToWrite {
  readonly path: string;
  readonly contents: string;
}

/**
 * Resolve a path under `root`, refusing anything that escapes it. Guards the
 * generated file paths against traversal from an untrusted `--dir` or name.
 */
export function safeJoin(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the project directory: ${parts.join('/')}`);
  }
  return target;
}

/** Which of these absolute paths already exist on disk. */
export function existingOf(paths: readonly string[]): string[] {
  return paths.filter((p) => existsSync(p));
}

/** Write every file, creating parent directories as needed. */
export function writeFiles(files: readonly FileToWrite[]): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents, 'utf8');
  }
}
