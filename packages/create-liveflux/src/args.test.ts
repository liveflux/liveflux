import { describe, expect, it } from 'vitest';
import { CliError, parseArgs } from './args';

describe('parseArgs — valid input', () => {
  it('parses a full, explicit selection', () => {
    expect(parseArgs(['--framework', 'react', '--adapter', 'ws', '--typescript'])).toMatchObject({
      framework: 'react',
      adapter: 'ws',
      typescript: true,
    });
  });

  it('supports short flags, inline =, --no-typescript and vanilla', () => {
    expect(parseArgs(['-f', 'vanilla', '--adapter=phoenix', '--no-typescript'])).toMatchObject({
      framework: 'vanilla',
      adapter: 'phoenix',
      typescript: false,
    });
  });

  it('takes a single bare positional as the target dir', () => {
    expect(parseArgs(['my-app']).dir).toBe('my-app');
  });

  it('never defaults an unspecified choice', () => {
    const a = parseArgs([]);
    expect(a.framework).toBeUndefined();
    expect(a.adapter).toBeUndefined();
    expect(a.typescript).toBeUndefined();
  });
});

describe('parseArgs — no bypass', () => {
  function expectUsageError(argv: string[], match: RegExp): void {
    let thrown: unknown;
    try {
      parseArgs(argv);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(2);
    expect((thrown as CliError).message).toMatch(match);
  }

  it.each(['-y', '--yes', '--skip', '--default', '--defaults', '--no-input', '--non-interactive'])(
    'rejects the skip/defaults flag %s',
    (flag) => expectUsageError([flag], /has no ".*" mode|chosen explicitly/i),
  );

  it('rejects a coming-soon adapter', () => expectUsageError(['--adapter', 'gql-ws'], /not available yet/i));
  it('rejects a coming-soon framework', () => expectUsageError(['--framework', 'vue'], /not available yet/i));
  it('rejects an unknown adapter', () => expectUsageError(['--adapter', 'nope'], /unknown adapter/i));
  it('rejects an unknown framework', () => expectUsageError(['--framework', 'nope'], /unknown framework/i));
  it('rejects an unknown flag', () => expectUsageError(['--wat'], /unknown flag/i));
  it('rejects a flag missing its value', () => expectUsageError(['--adapter'], /needs a value/i));
  it('rejects a second positional', () => expectUsageError(['a', 'b'], /unexpected argument/i));
});
