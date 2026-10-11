import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOCKER_OPTIONS_WITH_VALUE = new Set([
  '-e',
  '--env',
  '--env-file',
  '-a',
  '-h',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '-m',
  '--memory',
  '-l',
  '--label',
  '-c',
  '--cpu-shares',
  '--add-host',
  '--annotation',
  '--attach',
  '--blkio-weight',
  '--blkio-weight-device',
  '--cap-add',
  '--cap-drop',
  '--cgroup-parent',
  '--cgroupns',
  '--cidfile',
  '--cpu-period',
  '--cpu-quota',
  '--cpu-rt-period',
  '--cpu-rt-runtime',
  '--cpu-count',
  '--cpu-percent',
  '--cpus',
  '--net',
  '--cpuset-cpus',
  '--cpuset-mems',
  '--device',
  '--device-cgroup-rule',
  '--device-read-bps',
  '--device-read-iops',
  '--device-write-bps',
  '--device-write-iops',
  '--detach-keys',
  '--dns',
  '--dns-option',
  '--dns-search',
  '--domainname',
  '--entrypoint',
  '--expose',
  '--gpus',
  '--group-add',
  '--health-cmd',
  '--health-interval',
  '--health-retries',
  '--health-start-period',
  '--health-start-interval',
  '--health-timeout',
  '--hostname',
  '--ip',
  '--ip6',
  '--io-maxbandwidth',
  '--io-maxiops',
  '--ipc',
  '--isolation',
  '--kernel-memory',
  '--link',
  '--link-local-ip',
  '--log-driver',
  '--log-opt',
  '--mac-address',
  '--label-file',
  '--memory-reservation',
  '--memory-swap',
  '--memory-swappiness',
  '--mount',
  '--name',
  '--network',
  '--network-alias',
  '--oom-score-adj',
  '--pid',
  '--pids-limit',
  '--platform',
  '--pull',
  '--restart',
  '--runtime',
  '--security-opt',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--storage-opt',
  '--sysctl',
  '--tmpfs',
  '--ulimit',
  '--userns',
  '--uts',
  '--volume-driver',
  '--volumes-from',
]);

export function validateExtraEnv(extraEnv: Record<string, string>): void {
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!ENV_IDENTIFIER.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    if (/[\r\n\0]/.test(value)) {
      throw new Error(
        `Environment variable ${key} contains a forbidden line break or NUL`,
      );
    }
  }
}

const DOCKER_BOOLEAN_OPTIONS = new Set([
  '--disable-content-trust',
  '--detach',
  '-d',
  '--help',
  '--init',
  '--interactive',
  '-i',
  '--no-healthcheck',
  '--oom-kill-disable',
  '--privileged',
  '--publish-all',
  '-P',
  '--quiet',
  '-q',
  '--read-only',
  '--rm',
  '--sig-proxy',
  '--tty',
  '-t',
]);

const SHORT_OPTIONS_WITH_VALUE = new Set([
  'a',
  'c',
  'e',
  'h',
  'l',
  'm',
  'p',
  'u',
  'v',
  'w',
]);
const SHORT_BOOLEAN_OPTIONS = new Set(['d', 'i', 'P', 'q', 't']);

function resolveEnvReference(value: string, keys: Set<string>): boolean {
  return keys.has(value);
}

function parseShortOption(
  arg: string,
  next: string | undefined,
  keys: Set<string>,
): { args: string[]; consumesNext: boolean } {
  let booleanFlags = '';
  const flags = arg.slice(1);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === undefined) {
      continue;
    }
    if (SHORT_BOOLEAN_OPTIONS.has(flag)) {
      booleanFlags += flag;
      continue;
    }
    if (flag === '=' && booleanFlags.length > 0) {
      return { args: [arg], consumesNext: false };
    }
    if (!SHORT_OPTIONS_WITH_VALUE.has(flag)) {
      throw new Error(`Cannot safely parse Docker run/create option: ${arg}`);
    }

    let value = flags.slice(i + 1);
    const attached = value.length > 0;
    if (value.startsWith('=')) {
      value = value.slice(1);
    }
    const isEnv = flag === 'e';
    if (isEnv && attached && resolveEnvReference(value, keys)) {
      return {
        args: booleanFlags ? [`-${booleanFlags}`] : [],
        consumesNext: false,
      };
    }
    if (!attached) {
      if (next === undefined) {
        throw new Error(`Missing value for Docker option: ${arg}`);
      }
      if (isEnv && resolveEnvReference(next, keys)) {
        return {
          args: booleanFlags ? [`-${booleanFlags}`] : [],
          consumesNext: true,
        };
      }
      return { args: [arg, next], consumesNext: true };
    }
    return { args: [arg], consumesNext: false };
  }
  return { args: [arg], consumesNext: false };
}

/** Prepares run/create options, preserving the Docker IMAGE/command boundary. */
export function prepareDockerArgs(
  args: string[],
  keys: Set<string>,
  privateEnvFile: string,
): string[] {
  const command = args[0];
  if (command !== 'run' && command !== 'create') {
    throw new Error(
      'Environment transport is only supported for docker run or create commands',
    );
  }

  const prepared = [command];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--') {
      prepared.push('--env-file', privateEnvFile, '--', ...args.slice(i + 1));
      return prepared;
    }
    if (!arg.startsWith('-')) {
      prepared.push('--env-file', privateEnvFile, ...args.slice(i));
      return prepared;
    }

    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=');
      const option = equalsIndex < 0 ? arg : arg.slice(0, equalsIndex);
      const hasInlineValue = equalsIndex >= 0;
      const next = args[i + 1];
      if (option === '--env') {
        const value = hasInlineValue ? arg.slice(equalsIndex + 1) : next;
        if (value !== undefined && resolveEnvReference(value, keys)) {
          if (!hasInlineValue) {
            i++;
          }
          continue;
        }
        prepared.push(arg);
        if (!hasInlineValue && next !== undefined) {
          prepared.push(next);
          i++;
        }
        continue;
      }
      if (DOCKER_OPTIONS_WITH_VALUE.has(option)) {
        prepared.push(arg);
        if (!hasInlineValue) {
          if (next === undefined) {
            throw new Error(`Missing value for Docker option: ${arg}`);
          }
          prepared.push(next);
          i++;
        }
        continue;
      }
      if (DOCKER_BOOLEAN_OPTIONS.has(option) || hasInlineValue) {
        prepared.push(arg);
        continue;
      }
      throw new Error(`Cannot safely parse Docker run/create option: ${arg}`);
    }

    const parsed = parseShortOption(arg, args[i + 1], keys);
    prepared.push(...parsed.args);
    if (parsed.consumesNext) {
      i++;
    }
  }
  prepared.push('--env-file', privateEnvFile);
  return prepared;
}

export async function withPrivateEnvFile<T>(
  extraEnv: Record<string, string>,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  validateExtraEnv(extraEnv);
  const directory = await mkdtemp(
    join(tmpdir(), `ccpod-env-${process.getuid?.() ?? 'user'}-`),
  );
  try {
    await chmod(directory, 0o700);
    const filePath = join(directory, 'environment');
    const contents = Object.entries(extraEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    await writeFile(filePath, contents, { flag: 'wx', mode: 0o600 });
    await chmod(filePath, 0o600);
    return await run(filePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
