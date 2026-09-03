import chalk from 'chalk';
import { PROFILE_NAME_REGEX } from '../config/schema.ts';

/**
 * Validates a profile name from CLI args. Prints an error and exits if the
 * name is invalid (empty, contains path separators, shell metacharacters,
 * etc.). No-op when `name` is undefined (arg not provided).
 */
export function validateProfileArg(name: string | undefined): void {
  if (name !== undefined && !PROFILE_NAME_REGEX.test(name)) {
    // Sanitize control/ANSI escape chars before printing — an invalid name
    // could contain terminal escape sequences (log injection).
    const safeName = name.replace(/[^\x20-\x7E]/g, '?');
    console.error(
      `${chalk.red('error:')} Invalid profile name '${safeName}'. Profile names may only contain letters, digits, hyphens, and underscores (max 64 chars).`,
    );
    process.exit(1);
  }
}
