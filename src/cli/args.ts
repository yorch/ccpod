import { exitWithError } from './errors.ts';

/**
 * Every value of a repeatable string flag (`--env A=1 --env B=2`), in order.
 * citty (0.2.x) keeps only the LAST value of a repeated option, so read them
 * from the raw argv. Stops at `--` (what follows belongs to the child command).
 */
export function repeatedFlag(rawArgs: string[], name: string): string[] {
  const out: string[] = [];
  const long = `--${name}`;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i] ?? '';
    if (a === '--') {
      break;
    }
    if (a === long) {
      const next = rawArgs[i + 1];
      if (next !== undefined) {
        out.push(next);
        i++;
      }
    } else if (a.startsWith(`${long}=`)) {
      out.push(a.slice(long.length + 1));
    }
  }
  return out;
}

/**
 * citty silently drops positionals a command doesn't declare, so
 * `ccpod state clear work` quietly targets the *default* profile. Fail loudly
 * and point at the flag instead.
 */
export function rejectExtraPositionals(
  args: { _?: string[] },
  hint = 'use --profile <name>',
): void {
  const extra = (args._ ?? []).filter((a) => a !== '');
  if (extra.length > 0) {
    exitWithError(new Error(`Unexpected argument '${extra[0]}' — ${hint}.`));
  }
}

/**
 * Split argv at the first `--`: everything before is ccpod's, everything after
 * belongs to the child command and must never be interpreted by ccpod.
 */
export function splitPassthrough(rawArgs: string[]): {
  before: string[];
  passthrough: string[];
} {
  const sep = rawArgs.indexOf('--');
  return sep < 0
    ? { before: rawArgs, passthrough: [] }
    : { before: rawArgs.slice(0, sep), passthrough: rawArgs.slice(sep + 1) };
}

/**
 * The first real positional among `before` (args preceding `--`), skipping
 * flags and the values of the given value-taking flags. citty's own
 * positional also swallows the first token AFTER `--` (so `run -- --verbose`
 * looked like a headless prompt "--verbose"); this only ever looks before it.
 */
export function leadingPositional(
  before: string[],
  valueFlags: string[],
): string | undefined {
  for (let i = 0; i < before.length; i++) {
    const a = before[i] ?? '';
    if (a.startsWith('-')) {
      if (valueFlags.includes(a)) {
        i++; // skip the flag's value
      }
      continue;
    }
    return a;
  }
  return undefined;
}
