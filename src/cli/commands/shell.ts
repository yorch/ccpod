import chalk from 'chalk';
import { defineCommand } from 'citty';
import { ZodError } from 'zod';
import { buildContainerSpec } from '../../container/builder.ts';
import { shellContainer } from '../../container/runner.ts';
import { setupContainer } from './_setup.ts';

export default defineCommand({
  args: {
    env: {
      array: true,
      description: 'Pass/override env var (KEY or KEY=VALUE)',
      type: 'string',
    },
    'no-state': {
      default: false,
      description: 'Force ephemeral state for this session',
      type: 'boolean',
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
  },
  meta: {
    description: 'Open an interactive shell in the container',
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
          noState: args['no-state'],
          profile: args.profile,
          rebuild: args.rebuild,
        },
        cwd,
      );

      const spec = buildContainerSpec(config, cwd, true, networkName);
      spec.cmd = ['/bin/bash'];

      console.log(chalk.dim('Starting container...'));
      const exitCode = await shellContainer(spec);
      process.exit(exitCode);
    } catch (err) {
      if (err instanceof ZodError) {
        const lines = err.issues.map(
          (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
        );
        console.error(
          `${chalk.red('error:')} Config validation failed:\n${lines.join('\n')}`,
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${chalk.red('error:')} ${msg}`);
      }
      process.exit(1);
    }
  },
});
