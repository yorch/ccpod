/** Return the first subcommand-like token before `--` or positional arguments. */
export function firstCommandToken(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg === '--') {
      return undefined;
    }
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return undefined;
}

export function isDoctorCommandIntent(args: string[]): boolean {
  return firstCommandToken(args) === 'doctor';
}
