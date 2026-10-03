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
          "Stop it with 'ccpod down' before starting a headless run, or run " +
          'interactively (no prompt or --file) to attach to the session.',
      );
    }
    // In proxy auth mode the container's ANTHROPIC_BASE_URL/key point at the
    // auth proxy owned by the `ccpod run` process that created it. That proxy
    // dies with that process, and a proxy started by this run would never be
    // used by the existing container — reattaching would just hand the user a
    // session that fails (or dies when the original terminal exits).
    if (spec.proxyAuth) {
      throw new Error(
        `A container for this project is already running (${spec.name}) with a per-run auth proxy that cannot be shared. ` +
          "Stop it with 'ccpod down' and start again (auth.type: proxy sessions cannot be reattached).",
      );
    }
    console.log(`Reattaching to running container: ${spec.name}`);
    return deps.dockerSpawn(['attach', spec.name]);
  }

  await removeForFreshRun(spec.name, state, deps);
  return deps.dockerSpawn(buildRunArgs(spec), spec.secretEnv);
}

// Where a shell session goes: `docker exec` into the main (claude) container if
// it is up, else into a previous shell container, else (target null) a fresh
// shell container. `state` is the shell container's own lifecycle state.
async function resolveShellTarget(
  spec: ContainerSpec,
  deps: RunnerDeps,
): Promise<{ state: ContainerLifecycle; target: string | null }> {
  if (
    spec.execTarget &&
    (await containerState(spec.execTarget, deps.dockerExec)) === 'running'
  ) {
    return { state: 'not_found', target: spec.execTarget };
  }
  const state = await containerState(spec.name, deps.dockerExec);
  return { state, target: state === 'running' ? spec.name : null };
}

export async function findRunningShellTarget(
  spec: ContainerSpec,
  deps: RunnerDeps = defaultDeps(),
): Promise<string | null> {
  return (await resolveShellTarget(spec, deps)).target;
}

export async function shellContainer(
  spec: ContainerSpec,
  deps: RunnerDeps = defaultDeps(),
): Promise<number> {
  const { state, target } = await resolveShellTarget(spec, deps);
  if (target) {
    const cmd = spec.cmd ?? ['/bin/bash'];
    // The image's final USER is root (the entrypoint drops to node); exec
    // bypasses the entrypoint, so drop privileges explicitly or files created
    // in /workspace end up root-owned.
    return deps.dockerSpawn([
      'exec',
      spec.tty ? '-it' : '-i',
      '-u',
      'node',
      '-e',
      'HOME=/home/node',
      target,
      ...cmd,
    ]);
  }

  await removeForFreshRun(spec.name, state, deps);
  return deps.dockerSpawn(buildRunArgs(spec), spec.secretEnv);
}

// Lifecycle status from `docker inspect`. 'not_found' when the container does
// not exist. All other values map directly to Docker's `.State.Status`.
const CONTAINER_LIFECYCLES = [
  'created',
  'restarting',
  'running',
  'paused',
  'exited',
  'dead',
  'removing',
  'not_found',
] as const;
export type ContainerLifecycle = (typeof CONTAINER_LIFECYCLES)[number];

async function containerState(
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
  const status = stdout.trim();
  return CONTAINER_LIFECYCLES.find((l) => l === status) ?? 'not_found';
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
  // Bare `-e KEY` — docker reads the value from its own environment (injected
  // via dockerSpawn's extraEnv), keeping secrets out of the command line.
  for (const key of Object.keys(spec.secretEnv)) {
    args.push('-e', key);
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

  // Proxy auth mode: ensure host.docker.internal resolves inside the
  // container. Docker Desktop and OrbStack provide it automatically, but
  // Linux Docker Engine and Podman require --add-host.
  if (spec.proxyAuth) {
    args.push('--add-host=host.docker.internal:host-gateway');
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
