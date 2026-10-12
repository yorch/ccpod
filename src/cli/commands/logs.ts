import chalk from 'chalk';
import { defineCommand } from 'citty';
import { computeProjectHash } from '../../container/builder.ts';
import {
  type CcpodContainer,
  listCcpodContainers,
} from '../../container/list.ts';
import { dockerSpawn } from '../../runtime/docker.ts';
import { rejectExtraPositionals } from '../args.ts';
import { exitWithError } from '../errors.ts';
import { resolveProfileName } from '../profile-arg.ts';
import { validateProfileArg } from '../validate.ts';

const TAIL_RE = /^(?:all|[0-9]{1,7})$/;
const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export function logsFilter(
  profile: string,
  cwd: string,
  all: boolean,
  service?: string,
) {
  return {
    all: true,
    profile,
    ...(!all ? { project: computeProjectHash(cwd) } : {}),
    ...(service ? { service } : {}),
  };
}
export function dockerLogsArgs(
  id: string,
  tail: string,
  follow: boolean,
): string[] {
  return ['logs', '--tail', tail, ...(follow ? ['--follow'] : []), id];
}
export async function streamContainerLogs(
  containers: CcpodContainer[],
  tail: string,
  follow: boolean,
  labelAll: boolean,
  spawn: typeof dockerSpawn = dockerSpawn,
): Promise<void> {
  const stream = async (container: CcpodContainer) => {
    // Print the header immediately before this container's logs so it stays
    // attached to the output it labels instead of being batched up front.
    if (containers.length > 1 || labelAll) {
      console.log(
        chalk.bold(
          `==> ${container.name} (${container.type || 'container'}) <==`,
        ),
      );
    }
    const status = await spawn(dockerLogsArgs(container.id, tail, follow));
    if (status !== 0) {
      throw new Error(
        `docker logs failed for ${container.name} (exit ${status})`,
      );
    }
  };
  if (follow) {
    await Promise.all(containers.map(stream));
  } else {
    for (const container of containers) {
      await stream(container);
    }
  }
}
export default defineCommand({
  args: {
    all: {
      default: false,
      description: 'Show logs from all projects for the selected profile',
      type: 'boolean',
    },
    follow: {
      default: false,
      description: 'Follow log output',
      type: 'boolean',
    },
    profile: {
      description: 'Profile name (default: project profile or default)',
      type: 'string',
    },
    service: {
      description: 'Only show this named sidecar service',
      type: 'string',
    },
    tail: {
      default: '100',
      description: 'Number of lines (0-1000000) or all',
      type: 'string',
    },
  },
  meta: {
    description: 'View container logs (application secrets may be present)',
    name: 'logs',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    validateProfileArg(args.profile);
    if (
      !TAIL_RE.test(args.tail) ||
      (args.tail !== 'all' && Number(args.tail) > 1_000_000)
    ) {
      exitWithError(
        new Error('--tail must be all or an integer from 0 to 1000000'),
      );
    }
    if (args.service && !SERVICE_RE.test(args.service)) {
      exitWithError(new Error('Invalid service name'));
    }
    const profile = resolveProfileName(args.profile);
    let containers: CcpodContainer[];
    try {
      containers = await listCcpodContainers(
        logsFilter(profile, process.cwd(), args.all, args.service),
      );
    } catch (err) {
      exitWithError(err);
    }
    if (containers.length === 0) {
      console.log('No matching ccpod container logs.');
      return;
    }
    console.error(
      chalk.yellow(
        'Warning: application secrets may be present in container logs.',
      ),
    );
    try {
      await streamContainerLogs(containers, args.tail, args.follow, args.all);
    } catch (err) {
      exitWithError(err);
    }
  },
});
