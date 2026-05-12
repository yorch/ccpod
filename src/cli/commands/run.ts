import { isAbsolute, normalize } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { ZodError } from 'zod';
import { buildContainerSpec } from '../../container/builder.ts';
import { runContainer } from '../../container/runner.ts';
import { dockerExec } from '../../runtime/docker.ts';
import { setupContainer } from './_setup.ts';

function installSignalForwarding(containerName: string): () => void {
  let triggered = false;
  const handler = () => {
    if (triggered) {
      return;
    }
    triggered = true;
    void dockerExec(['stop', '-t', '5', containerName]).catch(() => {});
    detach();
  };
  const detach = () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return detach;
}

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
    resume: {
      description: 'Resume a previous Claude session by ID',
      type: 'string',
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
        ...(args.resume ? ['--resume', args.resume] : []),
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

      // In TTY mode docker -it forwards Ctrl+C to the container natively;
      // only headless mode needs ccpod-side signal forwarding to stop the
      // container so it is not orphaned.
      const detach = tty ? () => {} : installSignalForwarding(spec.name);
      let exitCode: number;
      try {
        exitCode = await runContainer(spec);
      } finally {
        detach();
      }
      if (tty && !args.resume) {
        const profileFlag = args.profile ? ` --profile ${args.profile}` : '';
        console.log(
          chalk.dim(
            `\nTo resume a session: ccpod run${profileFlag} --resume <session-id>`,
          ),
        );
      }
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
