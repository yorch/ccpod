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
        'Persist state per the profile; pass --no-state to force ephemeral state for this session',
      type: 'boolean',
    },
  },
  meta: {
    description: 'Open an interactive shell in the container',
    name: 'shell',
  },
  async run({ args, rawArgs }) {
    try {
      process.exit(
        await runSession({ ...args, env: repeatedFlag(rawArgs, 'env') }),
      );
    } catch (err) {
      exitWithError(err);
    }
  },
});
