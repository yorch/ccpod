import { dockerExec, dockerSpawn } from '../runtime/docker.ts';
import type { ContainerSpec } from './builder.ts';

type DockerExecFn = typeof dockerExec;
type DockerSpawnFn = typeof dockerSpawn;

export interface RunnerDeps {
  dockerExec: DockerExecFn;
  dockerSpawn: DockerSpawnFn;
}

function defaultDeps(): RunnerDeps {
  return { dockerExec, dockerSpawn };
}

export async function runContainer(
  spec: ContainerSpec,
  deps: RunnerDeps = defaultDeps(),
): Promise<number> {
  const state = await containerState(spec.name, deps.dockerExec);

  if (state === 'running') {
    // A headless run (tty=false) must not `docker attach` to a live
    // interactive session: attach would hijack its stdio and the caller's
    // signal forwarding could then stop the user's session. Only an
    // interactive run reattaches to resume the session.
    if (!spec.tty) {
      throw new Error(
        `A container for this project is already running (${spec.name}). ` +
          "Stop it with 'ccpod down' before starting a headless run, or omit " +
          '--file to attach to the interactive session.',
      );
    }
    console.log(`Reattaching to running container: ${spec.name}`);
    return deps.dockerSpawn(['attach', spec.name]);
  }

  await removeForFreshRun(spec.name, state, deps);
  return deps.dockerSpawn(buildRunArgs(spec));
}

export async function execContainer(
  name: string,
  cmd: string[],
  deps: RunnerDeps = defaultDeps(),
): Promise<number> {
  return deps.dockerSpawn(['exec', '-it', name, ...cmd]);
}

export async function shellContainer(
  spec: ContainerSpec,
  deps: RunnerDeps = defaultDeps(),
): Promise<number> {
  const state = await containerState(spec.name, deps.dockerExec);

  if (state === 'running') {
    const cmd = spec.cmd ?? ['/bin/bash'];
    return deps.dockerSpawn(['exec', '-it', spec.name, ...cmd]);
  }

  await removeForFreshRun(spec.name, state, deps);
  return deps.dockerSpawn(buildRunArgs(spec));
}

// Lifecycle status from `docker inspect`. 'not_found' when the container does
// not exist. All other values map directly to Docker's `.State.Status`.
export type ContainerLifecycle =
  | 'created'
  | 'restarting'
  | 'running'
  | 'paused'
  | 'exited'
  | 'dead'
  | 'removing'
  | 'not_found';

export async function containerState(
  name: string,
  dockerExecFn: DockerExecFn,
): Promise<ContainerLifecycle> {
  const { exitCode, stdout } = await dockerExecFn([
    'inspect',
    '--format',
    '{{.State.Status}}',
    name,
  ]);
  if (exitCode !== 0) {
    return 'not_found';
  }
  return (stdout.trim() || 'not_found') as ContainerLifecycle;
}

// Clear the way for a fresh `docker run` under this name. `rm -f` handles every
// removable state in one call — including paused, restarting, and dead, which a
// plain `rm` rejects. Two concurrent-lifecycle outcomes are tolerated rather
// than fatal: the container already vanished (`ccpod down` won the race), or its
// removal is still in progress. ccpod containers carry no restart policy, so the
// implicit SIGKILL from `rm -f` is safe here.
async function removeForFreshRun(
  name: string,
  state: ContainerLifecycle,
  deps: RunnerDeps,
): Promise<void> {
  if (state === 'not_found') {
    return;
  }
  const { exitCode, stderr } = await deps.dockerExec(['rm', '-f', name]);
  if (
    exitCode !== 0 &&
    !/no such container/i.test(stderr) &&
    !/removal .* already in progress/i.test(stderr)
  ) {
    throw new Error(`Failed to remove container '${name}': ${stderr}`);
  }
}

function buildRunArgs(spec: ContainerSpec): string[] {
  const args: string[] = ['run'];

  if (spec.tty) {
    args.push('-it');
  }

  args.push('--name', spec.name, '-w', spec.workingDir);

  for (const e of spec.env) {
    args.push('-e', e);
  }
  for (const b of spec.binds) {
    args.push('-v', b);
  }

  for (const [key, val] of Object.entries(spec.labels)) {
    args.push('--label', `${key}=${val}`);
  }

  for (const [containerPort, bindings] of Object.entries(spec.portBindings)) {
    const port = containerPort.replace('/tcp', '');
    for (const hb of bindings) {
      args.push(
        '-p',
        hb.HostIp
          ? `${hb.HostIp}:${hb.HostPort}:${port}`
          : `${hb.HostPort}:${port}`,
      );
    }
  }

  for (const cap of spec.capAdd ?? []) {
    args.push('--cap-add', cap);
  }

  if (spec.networkMode && spec.networkMode !== 'bridge') {
    args.push('--network', spec.networkMode);
  }

  for (const [path, opts] of Object.entries(spec.tmpfs ?? {})) {
    args.push('--tmpfs', `${path}:${opts}`);
  }

  args.push(spec.image);

  if (spec.cmd && spec.cmd.length > 0) {
    args.push(...spec.cmd);
  }

  return args;
}
