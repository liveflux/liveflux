import { resolve } from 'node:path';
import { intro, log, note, outro, spinner } from '@clack/prompts';
import { CliError, parseArgs } from './args';
import { detectPackageManager } from './detect';
import { installPackages } from './install';
import { promptAdapter, promptConfirm, promptFramework, promptTypescript } from './prompts';
import { ADAPTERS, byId } from './registry';
import { existingOf, safeJoin, writeFiles } from './scaffold';
import { packagesFor } from './select';
import { clientModule, exampleModule, filenames } from './templates';

const VERSION = '0.1.0';

const HELP = `create-liveflux — scaffold Liveflux into your project

Usage
  pnpm create liveflux [dir] [options]

Every option is chosen explicitly — interactively, or via flags. There is no
"accept defaults" mode.

Options
  -f, --framework <react|vanilla>   framework binding
  -a, --adapter   <ws|phoenix>      transport adapter
      --typescript | --no-typescript
      --dir <path>                  target project (default: .)
      --force                       overwrite existing generated files
  -h, --help                        show this help
  -v, --version                     show version

Non-interactively, pass all of --framework, --adapter and --typescript/--no-typescript.`;

function requireFlag(flag: string): never {
  throw new CliError(
    `Non-interactive run: choose ${flag} explicitly (no TTY to prompt, and this CLI has no defaults).`,
    2,
  );
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  const dir = resolve(args.dir);
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);

  intro('create-liveflux');

  const framework = args.framework ?? (interactive ? await promptFramework() : requireFlag('--framework'));
  const adapter = args.adapter ?? (interactive ? await promptAdapter() : requireFlag('--adapter'));
  const typescript =
    args.typescript ?? (interactive ? await promptTypescript() : requireFlag('--typescript / --no-typescript'));

  const packages = packagesFor({ framework, adapter, typescript });
  const names = filenames(framework, typescript);
  const adapterChoice = byId(ADAPTERS, adapter)!;
  const files = [
    { path: safeJoin(dir, names.client), contents: clientModule(adapterChoice, typescript) },
    { path: safeJoin(dir, names.example), contents: exampleModule(framework, adapterChoice, typescript) },
  ];

  const existing = existingOf(files.map((f) => f.path));
  if (existing.length > 0 && !args.force) {
    if (!interactive) {
      throw new CliError(`Refusing to overwrite existing file(s): ${existing.join(', ')}. Pass --force.`, 1);
    }
    const ok = await promptConfirm(`Overwrite ${existing.length} existing file(s)?`);
    if (!ok) {
      outro('Cancelled — nothing was changed.');
      return;
    }
  }

  note(
    [
      `framework   ${framework}`,
      `adapter     ${adapter}`,
      `language    ${typescript ? 'TypeScript' : 'JavaScript'}`,
      `install     ${packages.join(' ')}`,
      `files       ${names.client}, ${names.example}`,
    ].join('\n'),
    'Plan',
  );

  if (interactive && !(await promptConfirm('Proceed?'))) {
    outro('Cancelled — nothing was changed.');
    return;
  }

  const pm = detectPackageManager(dir);
  const s = spinner();
  s.start(`Installing ${packages.length} package(s) with ${pm}`);
  try {
    await installPackages(pm, packages, dir);
    s.stop(`Installed with ${pm}`);
  } catch (error) {
    s.stop('Install failed');
    throw error;
  }

  writeFiles(files);
  log.success(`Wrote ${names.client} and ${names.example}`);

  const usage =
    framework === 'react'
      ? `Set ENDPOINT in ${names.client}, then render <LivefluxProvider client={client}> and use useStream — see ${names.example}.`
      : `Set ENDPOINT in ${names.client}, then use client.subscribe(...) — see ${names.example}.`;
  outro(`Done. ${usage}`);
}

run().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(1);
});
