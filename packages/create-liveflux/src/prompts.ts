import { cancel, confirm, isCancel, note, select } from '@clack/prompts';
import { ADAPTERS, FRAMEWORKS, soon, stable, type Choice } from './registry';

function abortIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Aborted — nothing was installed or written.');
    process.exit(130);
  }
  return value as T;
}

/**
 * Pick one stable choice. Only stable options are selectable — `soon` ones are
 * shown as an info note but can never be chosen, so the prompt can't produce an
 * unavailable value.
 */
async function pick(message: string, choices: readonly Choice[]): Promise<string> {
  const coming = soon(choices);
  if (coming.length > 0) {
    note(coming.map((c) => `${c.label} — coming soon`).join('\n'), 'Not available yet');
  }
  const options = stable(choices).map((c) => ({ value: c.id, label: c.label, hint: c.hint }));
  return abortIfCancelled(await select({ message, options }));
}

export const promptFramework = (): Promise<string> => pick('Which framework binding?', FRAMEWORKS);
export const promptAdapter = (): Promise<string> => pick('Which transport adapter?', ADAPTERS);

export async function promptTypescript(): Promise<boolean> {
  return abortIfCancelled(await confirm({ message: 'Use TypeScript?' }));
}

export async function promptConfirm(message: string): Promise<boolean> {
  return abortIfCancelled(await confirm({ message }));
}
