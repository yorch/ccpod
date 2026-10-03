import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { buildContainerSpec } from '../../container/builder.ts';
import { runContainer } from '../../container/runner.ts';
import { dockerExec } from '../../runtime/docker.ts';
import { leadingPositional, repeatedFlag, splitPassthrough } from '../args.ts';
import { withAuthProxy } from '../auth-proxy.ts';
import { exitWithError } from '../errors.ts';
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

const MAX_PROMPT_BYTES = 100_000;

function readPromptFile(absPath: string, shown: string): string {
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read --file '${shown}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (text.trim() === '') {
    throw new Error(`--file '${shown}' is empty`);
  }
  // The prompt travels as a command-line argument to `docker run` (and so is
  // visible in `ps` / `docker inspect`); Linux caps a single argument at 128 KiB.
  if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
    throw new Error(
      `--file '${shown}' is too large (${Buffer.byteLength(text)} bytes; max ${MAX_PROMPT_BYTES}). Put long instructions in CLAUDE.md or the project and keep the prompt short.`,
    );
  }
  return text;
}

// Flags of `ccpod run` that consume the following token as their value.
const RUN_VALUE_FLAGS = ['--env', '--file', '--profile', '--resume'];

export default defineCommand({
  args: {
    env: {
      description: 'Pass/override env var (KEY or KEY=VALUE)',
      type: 'string',
    },
    file: {
      description:
        'Headless mode: read the prompt from this file (relative to the project)',
      type: 'string',
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
    // Declared as `state` (default true) because citty parses `--no-<name>` as
    // `<name>: false` — a literal `no-state` arg would never be set by it.
    state: {
      default: true,
      description:
        'Persist state per the profile; pass --no-state to force ephemeral state for this run',
      type: 'boolean',
    },
  },
  meta: {
    description: 'Run Claude Code in a container (interactive or headless)',
    name: 'run',
  },
  async run({ args, rawArgs }) {
    try {
      const cwd = process.cwd();
      console.log(chalk.dim('Loading config...'));

      // Everything after `--` belongs to claude. citty's own `prompt`
      // positional also grabs the first token after `--`, so derive the prompt
      // and the passthrough from the raw argv instead.
      const { before, passthrough: passthroughArgs } =
        splitPassthrough(rawArgs);
      const promptArg = leadingPositional(before, RUN_VALUE_FLAGS);
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

      if (promptArg && passthroughArgs.some((a) => !a.startsWith('-'))) {
        console.error(
          `${chalk.red('error:')} cannot combine inline prompt with bare positional args after --`,
        );
        process.exit(1);
      }

      const envArgs = repeatedFlag(rawArgs, 'env');
      const promptText = fileArg
        ? readPromptFile(join(cwd, fileArg), fileArg)
        : promptArg;
      const headless = promptText !== undefined;
      const claudeArgs = [
        ...(args.resume ? ['--resume', args.resume] : []),
        ...passthroughArgs,
        // Headless: `-p` runs a single non-interactive turn and prints the
        // result; the prompt is the argument that follows.
        ...(headless ? ['-p', promptText] : []),
      ];

      const { config, networkName } = await setupContainer(
        {
          claudeArgs,
          envArgs,
          noState: args.state === false,
          profile: args.profile,
          rebuild: args.rebuild,
          requireAuth: headless,
        },
        cwd,
      );

      const tty = !headless;

      // In TTY mode docker -it forwards Ctrl+C to the container natively;
      // only headless mode needs ccpod-side signal forwarding to stop the
      // container so it is not orphaned.
      const { exitCode, spec } = await withAuthProxy(
        config,
        true,
        async (proxy) => {
          const spec = buildContainerSpec(config, cwd, tty, networkName, {
            ...(proxy ? { proxy } : {}),
          });
          console.log(chalk.dim('Starting container...'));
          const detach = tty ? () => {} : installSignalForwarding(spec.name);
          try {
            return { exitCode: await runContainer(spec), spec };
          } finally {
            detach();
          }
        },
      );

      // Proxy mode: the proxy just stopped. If the user detached
      // (Ctrl-P Ctrl-Q) rather than exiting, the container is still running
      // but can no longer reach the API.
      if (config.auth.type === 'proxy' && tty) {
        const { stdout } = await dockerExec([
          'inspect',
          '--format',
          '{{.State.Running}}',
          spec.name,
        ]);
        if (stdout.trim() === 'true') {
          console.warn(
            chalk.yellow(
              `\nWarning: container ${spec.name} is still running, but its auth proxy has stopped, so API calls from it will fail. Run 'ccpod down' to stop it.`,
            ),
          );
        }
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
      exitWithError(err);
    }
  },
});
