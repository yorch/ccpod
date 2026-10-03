import { defineCommand } from 'citty';
import { repeatedFlag } from '../args.ts';
import { exitWithError } from '../errors.ts';
import { runSession } from '../session.ts';

export default defineCommand({
  args: {
    env: {
      description: 'Pass/override env var (KEY or KEY=VALUE)',
      type: 'string',
    },
    profile: {
      description: 'Profile name (overrides .ccpod.yml)',
      type: 'string',
    },
    rebuild: {
      default: false,
      description: 'Force image rebuild/repull',
      type: 'boolean',
    },
    // Declared as `state` because citty parses `--no-state` as `state: false`.
    state: {
      default: true,
      description:
        'Persist state per the profile; pass --no-state to force ephemeral state for this command',
      type: 'boolean',
    },
  },
  meta: {
    description:
      'Run a one-off command in the project container: ccpod exec -- <command> [args...]',
    name: 'exec',
  },
  async run({ args, rawArgs }) {
    const sep = process.argv.indexOf('--');
    const cmd = sep >= 0 ? process.argv.slice(sep + 1) : [];
    if (cmd.length === 0) {
      exitWithError(
        new Error('No command given. Usage: ccpod exec -- <command> [args...]'),
      );
    }
    // Keep stdout clean for piping: setup progress goes to stderr.
    const log = console.log;
    console.log = console.error;
    try {
      const code = await runSession(
        { ...args, env: repeatedFlag(rawArgs, 'env') },
        cmd,
        process.stdin.isTTY === true,
      );
      console.log = log;
      process.exit(code);
    } catch (err) {
      console.log = log;
      exitWithError(err);
    }
  },
});
