import { isAbsolute, normalize } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { ZodError } from 'zod';
import { buildContainerSpec } from '../../container/builder.ts';
import { runContainer } from '../../container/runner.ts';
import { dockerExec } from '../../runtime/docker.ts';
import { setupContainer } from './_setup.ts';

function installSignalForwarding(
  containerName: string,
  tty: boolean,
): () => void {
  // In TTY mode, docker -it forwards Ctrl+C through to the container's own
  // signal handler. Intercepting at the ccpod layer there only risks
  // swallowing subsequent signals (the user could never Ctrl+C ccpod
  // itself if attach wedged). Only register in headless mode.
  if (tty) {
    return () => {};
  }
  let triggered = false;
  const handler = (_signal: NodeJS.Signals) => {
    if (triggered) {
      return;
    }
    triggered = true;
    // Fire-and-forget: dockerExec will eventually return; ccpod's main await
    // resolves and process exits with the container's status.
    void dockerExec(['stop', '-t', '5', containerName]).catch(() => {});
    // Detach so a second Ctrl+C falls through to Node's default handler and
    // kills ccpod immediately.
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
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

      // In TTY mode docker forwards Ctrl+C through to the container; in
      // headless mode the docker child does not, so the container would be
      // orphaned (left as "stopped" rather than removed). Forward SIGINT /
      // SIGTERM by asking docker to stop the container; the docker run
      // child then exits cleanly and runContainer's await resolves.
      const cleanup = installSignalForwarding(spec.name, tty);
      let exitCode: number;
      try {
        exitCode = await runContainer(spec);
      } finally {
        cleanup();
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
