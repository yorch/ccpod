import { isAbsolute, normalize } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { ZodError } from 'zod';
import { buildContainerSpec } from '../../container/builder.ts';
import { runContainer } from '../../container/runner.ts';
import { setupContainer } from './_setup.ts';

export default defineCommand({
  args: {
    env: {
      array: true,
      description: 'Pass/override env var (KEY or KEY=VALUE)',
      type: 'string',
    },
    file: { description: 'Headless mode: path to prompt file', type: 'string' },
    'no-state': {
      default: false,
      description: 'Force ephemeral state for this run',
      type: 'boolean',
    },
    profile: {
      description: 'Profile name (overrides .ccpod.yml)',
      type: 'string',
    },
    prompt: {
      description: 'Headless mode: prompt text passed directly to claude',
      required: false,
      type: 'positional',
    },
    rebuild: {
      default: false,
      description: 'Force image rebuild/repull',
      type: 'boolean',
    },
  },
  meta: {
    description: 'Run Claude Code in a container (interactive or headless)',
  },
  async run({ args }) {
    try {
      const cwd = process.cwd();
      console.log(chalk.dim('Loading config...'));

      const promptArg = args.prompt as string | undefined;
      if (args.file && promptArg) {
        console.error(
          `${chalk.red('error:')} --file and prompt text are mutually exclusive`,
        );
        process.exit(1);
      }

      let fileArg: string | undefined;
      if (args.file) {
        const normalized = normalize(args.file);
        if (isAbsolute(normalized) || normalized.startsWith('..')) {
          console.error(
            `${chalk.red('error:')} --file must be a relative path within the project directory`,
          );
          process.exit(1);
        }
        fileArg = normalized;
      }

      const passthroughIdx = process.argv.indexOf('--');
      const passthroughArgs =
        passthroughIdx >= 0 ? process.argv.slice(passthroughIdx + 1) : [];

      if (promptArg && passthroughArgs.some((a) => !a.startsWith('-'))) {
        console.error(
          `${chalk.red('error:')} cannot combine inline prompt with bare positional args after --`,
        );
        process.exit(1);
      }

      const envArgs = ([] as string[]).concat(args.env ?? []);
      const claudeArgs = [
        ...(fileArg ? ['--file', `/workspace/${fileArg}`] : []),
        ...passthroughArgs,
        ...(promptArg ? [promptArg] : []),
      ];

      const { config, networkName } = await setupContainer(
        {
          claudeArgs,
          envArgs,
          noState: args['no-state'],
          profile: args.profile,
          rebuild: args.rebuild,
          requireAuth: !!(fileArg || promptArg),
        },
        cwd,
      );

      const tty = !fileArg && !promptArg;
      const spec = buildContainerSpec(config, cwd, tty, networkName);
      console.log(chalk.dim('Starting container...'));
      const exitCode = await runContainer(spec);
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
