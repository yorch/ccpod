import chalk from 'chalk';
import { buildContainerSpec } from '../container/builder.ts';
import { findRunningShellTarget, shellContainer } from '../container/runner.ts';
import { withAuthProxy } from './auth-proxy.ts';
import { setupContainer } from './commands/_setup.ts';

export interface SessionArgs {
  env?: string[];
  profile?: string;
  rebuild?: boolean;
  /** False when the user passed --no-state. */
  state?: boolean;
}

/**
 * Run `cmd` (default: an interactive bash) in the project's container:
 * `docker exec` into the running main/shell container if there is one,
 * otherwise a separate `-shell` container. Returns the command's exit code.
 */
export async function runSession(
  args: SessionArgs,
  cmd?: string[],
  tty = true,
): Promise<number> {
  const cwd = process.cwd();
  console.log(chalk.dim('Loading config...'));

  const { config, networkName } = await setupContainer(
    {
      claudeArgs: [],
      envArgs: args.env ?? [],
      noState: args.state === false,
      profile: args.profile,
      rebuild: args.rebuild,
    },
    cwd,
  );

  const specOpts = { mode: 'shell' as const, ...(cmd ? { cmd } : {}) };
  const baseSpec = buildContainerSpec(config, cwd, tty, networkName, specOpts);
  // Exec'ing into an already-running container needs no auth proxy; only a
  // fresh container does.
  const reuse = await findRunningShellTarget(baseSpec);

  if (
    reuse &&
    ((args.env?.length ?? 0) > 0 || args.state === false || args.rebuild)
  ) {
    console.error(
      chalk.yellow(
        `Warning: attaching to the running container ${reuse}; --env, --no-state and --rebuild only apply to a newly started container and were ignored.`,
      ),
    );
  }

  return withAuthProxy(config, !reuse, async (proxy) => {
    const spec = proxy
      ? buildContainerSpec(config, cwd, tty, networkName, {
          ...specOpts,
          proxy,
        })
      : baseSpec;
    console.log(chalk.dim('Starting container...'));
    return shellContainer(spec);
  });
}
