import chalk from 'chalk';
import { buildContainerSpec } from '../container/builder.ts';
import { findRunningShellTarget, shellContainer } from '../container/runner.ts';
import { withAuthProxy } from './auth-proxy.ts';
import { setupContainer } from './commands/_setup.ts';

function installProxySessionSignals(): {
  detach: () => void;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  return {
    detach: () => {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    },
    signal: controller.signal,
  };
}

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
  // Install before target inspection so cancellation cannot slip through the
  // inspect/create gap. Reused containers discard this signal and are never
  // stopped by a shell/exec caller.
  let forwarding =
    config.auth.type === 'proxy' ? installProxySessionSignals() : undefined;
  let reuse: string | null;
  try {
    reuse = await findRunningShellTarget(baseSpec);
  } catch (error) {
    forwarding?.detach();
    throw error;
  }
  if (reuse) {
    const cancelled = forwarding?.signal.aborted ?? false;
    forwarding?.detach();
    forwarding = undefined;
    if (cancelled) {
      throw new Error('Container startup cancelled');
    }
  }

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

  try {
    return await withAuthProxy(config, !reuse, async (proxy) => {
      const spec = proxy
        ? buildContainerSpec(config, cwd, tty, networkName, {
            ...specOpts,
            proxy,
          })
        : baseSpec;
      console.log(chalk.dim('Starting container...'));
      return shellContainer(spec, undefined, forwarding?.signal, {
        // If the earlier target check found a reusable proxy container, no new
        // auth proxy was started. Fail if that target disappears rather than
        // creating a container that cannot authenticate.
        allowProxyCreate: Boolean(proxy),
      });
    });
  } finally {
    forwarding?.detach();
  }
}
