import { ADAPTERS, FRAMEWORKS, byId, stable, type Choice } from './registry';

/** A CLI-level failure with a process exit code. 2 = usage error, 1 = runtime. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * The result of parsing argv. Choices are `undefined` when not supplied — they
 * are NEVER defaulted here. The orchestrator resolves each undefined choice by
 * prompting (TTY) or erroring (non-TTY); there is no skip/defaults path.
 */
export interface ParsedArgs {
  framework?: string;
  adapter?: string;
  typescript?: boolean;
  dir: string;
  force: boolean;
  help: boolean;
  version: boolean;
}

/** Flags we deliberately reject: this CLI has no "accept defaults" shortcut. */
const REJECTED_SKIP_FLAGS = new Set([
  '-y',
  '--yes',
  '--skip',
  '--default',
  '--defaults',
  '--no-input',
  '--non-interactive',
]);

/** Reject unknown/`soon` ids up front — the gate that flags cannot slip past. */
function requireStable(kind: 'framework' | 'adapter', id: string, choices: readonly Choice[]): string {
  const c = byId(choices, id);
  const available = stable(choices)
    .map((x) => x.id)
    .join(', ');
  if (!c) {
    throw new CliError(`Unknown ${kind} "${id}". Available: ${available}.`, 2);
  }
  if (c.status !== 'stable') {
    throw new CliError(`The ${kind} "${id}" is not available yet (coming soon). Available: ${available}.`, 2);
  }
  return c.id;
}

/** Value for a `--flag value` / `--flag=value` token; throws if missing. */
function takeValue(name: string, inline: string | undefined, argv: string[], i: { v: number }): string {
  if (inline !== undefined) return inline;
  const next = argv[i.v + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new CliError(`Flag "${name}" needs a value.`, 2);
  }
  i.v += 1;
  return next;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { dir: '.', force: false, help: false, version: false };
  let sawDir = false;
  const i = { v: 0 };

  for (; i.v < argv.length; i.v += 1) {
    const token = argv[i.v]!;
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (REJECTED_SKIP_FLAGS.has(name)) {
      throw new CliError(
        `create-liveflux has no "${name}" mode — every option is chosen explicitly. ` +
          `Run it interactively, or pass --framework, --adapter and --typescript/--no-typescript.`,
        2,
      );
    }

    switch (name) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      case '-f':
      case '--framework':
        out.framework = requireStable('framework', takeValue(name, inline, argv as string[], i), FRAMEWORKS);
        break;
      case '-a':
      case '--adapter':
        out.adapter = requireStable('adapter', takeValue(name, inline, argv as string[], i), ADAPTERS);
        break;
      case '--ts':
      case '--typescript':
        out.typescript = true;
        break;
      case '--js':
      case '--no-typescript':
        out.typescript = false;
        break;
      case '--dir':
        out.dir = takeValue(name, inline, argv as string[], i);
        sawDir = true;
        break;
      case '--force':
        out.force = true;
        break;
      default:
        if (name.startsWith('-')) {
          throw new CliError(`Unknown flag "${name}".`, 2);
        }
        // a single bare positional is the target directory
        if (sawDir) {
          throw new CliError(`Unexpected argument "${token}".`, 2);
        }
        out.dir = token;
        sawDir = true;
    }
  }

  return out;
}
