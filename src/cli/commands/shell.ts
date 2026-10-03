import chalk from 'chalk';
import { defineCommand } from 'citty';
import { buildContainerSpec } from '../../container/builder.ts';
import {
  findRunningShellTarget,
  shellContainer,
} from '../../container/runner.ts';
import { withAuthProxy } from '../auth-proxy.ts';
import { exitWithError } from '../errors.ts';
import { setupContainer } from './_setup.ts';

export default defineCommand({
  args: {
    env: {
      array: true,
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
  async run({ args }) {
    try {
      const cwd = process.cwd();
      console.log(chalk.dim('Loading config...'));

      const envArgs = ([] as string[]).concat(args.env ?? []);
      const { config, networkName } = await setupContainer(
        {
          claudeArgs: [],
          envArgs,
          noState: args.state === false,
          profile: args.profile,
          rebuild: args.rebuild,
        },
        cwd,
      );

      const baseSpec = buildContainerSpec(config, cwd, true, networkName, {
        mode: 'shell',
      });
      // Exec'ing into an already-running container needs no auth proxy; only a
      // fresh shell container does.
      const reuse = await findRunningShellTarget(baseSpec);

      const exitCode = await withAuthProxy(config, !reuse, async (proxy) => {
        const spec = proxy
          ? buildContainerSpec(config, cwd, true, networkName, {
              mode: 'shell',
              proxy,
            })
          : baseSpec;
        console.log(chalk.dim('Starting container...'));
        return shellContainer(spec);
      });
      process.exit(exitCode);
    } catch (err) {
      exitWithError(err);
    }
  },
});
