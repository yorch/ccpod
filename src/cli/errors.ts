import chalk from 'chalk';
import { ZodError } from 'zod';

/** Human-readable message for any thrown value (Zod issues listed per path). */
export function formatCliError(err: unknown): string {
  if (err instanceof ZodError) {
    const lines = err.issues.map(
      (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    return `Config validation failed:\n${lines.join('\n')}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Print `error: <message>` to stderr and exit 1. */
export function exitWithError(err: unknown): never {
  console.error(`${chalk.red('error:')} ${formatCliError(err)}`);
  process.exit(1);
}
