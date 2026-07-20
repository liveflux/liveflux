import { spawn } from 'node:child_process';
import { addCommand, type PackageManager } from './detect';

/**
 * Install packages by delegating to the detected package manager, inheriting
 * stdio so the user sees real install output. Resolves on exit 0, rejects
 * otherwise. On Windows the PM is a `.cmd` shim, so a shell is used there only.
 */
export function installPackages(pm: PackageManager, packages: readonly string[], dir: string): Promise<void> {
  const { command, args } = addCommand(pm, packages);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`\`${command} ${args.join(' ')}\` exited with code ${code ?? 'null'}.`));
    });
  });
}
