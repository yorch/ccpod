import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_DIR_OWNER = String(process.getuid?.() ?? 'user');
const ENV_DIR_PREFIX = `ccpod-env-${ENV_DIR_OWNER}-`;
// Private scratch directories ccpod creates per process, all PID-tagged:
//   ccpod-env-<uid>-<pid>-XXXX        resolved env values (secrets)
//   ccpod-owned-cid-<uid>-<pid>-XXXX  docker --cidfile for an owned create
const PRIVATE_DIR_PREFIXES = [
  ENV_DIR_PREFIX,
  `ccpod-owned-cid-${ENV_DIR_OWNER}-`,
];
// Bound the sweep so a pathological temp directory cannot stall startup.
const SWEEP_MAX_DIRECTORIES = 256;
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
    if (value.includes('\0')) {
      throw new Error(`Environment variable ${key} contains a forbidden NUL`);
    }
  }
}

/**
 * Split resolved environment values by transport. Docker's `--env-file` format
 * is line-based, so values carrying CR/LF cannot be represented there without
 * corruption — those few keys (PEM blobs, JSON credentials) travel in the
 * Docker CLI's own environment with a bare `-e KEY`, which keeps them out of
 * argv exactly like the env-file does. NUL is rejected outright.
 */
export function splitEnvForTransport(extraEnv: Record<string, string>): {
  fileValues: Record<string, string>;
  inlineValues: Record<string, string>;
} {
  const fileValues: Record<string, string> = {};
  const inlineValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(extraEnv)) {
    if (/[\r\n]/.test(value)) {
      inlineValues[key] = value;
    } else {
      fileValues[key] = value;
    }
  }
  return { fileValues, inlineValues };
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
    if (isEnv && attached && keys.has(value)) {
      return {
        args: booleanFlags ? [`-${booleanFlags}`] : [],
        consumesNext: false,
      };
    }
    if (!attached) {
      if (next === undefined) {
        throw new Error(`Missing value for Docker option: ${arg}`);
      }
      if (isEnv && next !== undefined && keys.has(next)) {
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
  privateEnvFile?: string,
): string[] {
  const envFileFlag =
    privateEnvFile === undefined ? [] : ['--env-file', privateEnvFile];
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
      prepared.push(...envFileFlag, '--', ...args.slice(i + 1));
      return prepared;
    }
    if (!arg.startsWith('-')) {
      prepared.push(...envFileFlag, ...args.slice(i));
      return prepared;
    }

    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=');
      const option = equalsIndex < 0 ? arg : arg.slice(0, equalsIndex);
      const hasInlineValue = equalsIndex >= 0;
      const next = args[i + 1];
      if (option === '--env') {
        const value = hasInlineValue ? arg.slice(equalsIndex + 1) : next;
        if (value !== undefined && keys.has(value)) {
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
  prepared.push(...envFileFlag);
  return prepared;
}

export interface EnvTransportPlan {
  /** Keys carried by the private env-file. */
  fileKeys: Set<string>;
  /** Private env-file path, or undefined when no value needs a file. */
  filePath?: string;
  /** Values with line breaks, carried by the Docker CLI environment. */
  inlineValues: Record<string, string>;
}

let sweptPrivateDirectories = false;

function isAlivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as { code?: string } | null)?.code === 'EPERM';
  }
}

/**
 * Remove ccpod's private scratch directories whose owning process is gone. A
 * live session keeps its own directory (so nothing in use is ever removed,
 * however old it is); only SIGKILL/OOM leftovers — which skip the normal
 * cleanup — are reclaimed. Best effort: this never throws.
 */
export async function sweepStalePrivateDirectories(): Promise<void> {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const candidates = entries
    .flatMap((name) => {
      const prefix = PRIVATE_DIR_PREFIXES.find((candidate) =>
        name.startsWith(candidate),
      );
      if (prefix === undefined || name.startsWith(`${prefix}${process.pid}-`)) {
        return [];
      }
      return [{ name, pid: Number(name.slice(prefix.length).split('-')[0]) }];
    })
    .filter(({ pid }) => Number.isInteger(pid) && pid > 0 && !isAlivePid(pid))
    .slice(0, SWEEP_MAX_DIRECTORIES);

  for (const { name } of candidates) {
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        continue;
      }
      if (
        typeof process.getuid === 'function' &&
        info.uid !== process.getuid()
      ) {
        continue;
      }
      if ((info.mode & 0o777) !== 0o700) {
        continue;
      }
      await rm(path, { force: true, recursive: true });
    } catch {
      // Another process may have reclaimed it first.
    }
  }
}

export async function withPrivateEnvFile<T>(
  extraEnv: Record<string, string>,
  run: (plan: EnvTransportPlan) => Promise<T>,
): Promise<T> {
  validateExtraEnv(extraEnv);
  if (!sweptPrivateDirectories) {
    sweptPrivateDirectories = true;
    await sweepStalePrivateDirectories();
  }

  const { fileValues, inlineValues } = splitEnvForTransport(extraEnv);
  const fileKeys = new Set(Object.keys(fileValues));
  if (fileKeys.size === 0) {
    return run({ fileKeys, inlineValues });
  }

  // The owning PID is part of the name so a later ccpod can tell leftovers
  // (dead owner) from a live session's directory after an unclean exit.
  const directory = await mkdtemp(
    join(tmpdir(), `${ENV_DIR_PREFIX}${process.pid}-`),
  );
  try {
    await chmod(directory, 0o700);
    const filePath = join(directory, 'environment');
    const contents = Object.entries(fileValues)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    await writeFile(filePath, contents, { flag: 'wx', mode: 0o600 });
    await chmod(filePath, 0o600);
    return await run({ fileKeys, filePath, inlineValues });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
