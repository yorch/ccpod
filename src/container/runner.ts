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
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const state = await containerState(spec.name, deps.dockerExec);
  throwIfAborted(signal);

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
  throwIfAborted(signal);
  if (spec.proxyAuth || (signal !== undefined && !spec.tty)) {
    return runOwnedContainer(spec, deps, signal);
  }
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
  signal?: AbortSignal,
  options: { allowProxyCreate?: boolean } = {},
): Promise<number> {
  throwIfAborted(signal);
  const { state, target } = await resolveShellTarget(spec, deps);
  throwIfAborted(signal);
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

  if (spec.proxyAuth && options.allowProxyCreate === false) {
    throw new Error(
      'The existing proxy-backed container stopped before shell attach; retry the command to start a new session.',
    );
  }

  await removeForFreshRun(spec.name, state, deps);
  throwIfAborted(signal);
  if (spec.proxyAuth) {
    return runOwnedContainer(spec, deps, signal);
  }
  return deps.dockerSpawn(buildRunArgs(spec), spec.secretEnv);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Container startup cancelled');
  }
}

async function runOwnedContainer(
  spec: ContainerSpec,
  deps: RunnerDeps,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const createArgs = buildRunArgs(spec);
  createArgs[0] = 'create';
  const created = await deps.dockerExec(createArgs, spec.secretEnv);
  if (created.exitCode !== 0) {
    // A name conflict may belong to a concurrent invocation. No cleanup by
    // name is safe here because this call did not obtain an owned container ID.
    throw new Error(
      `Failed to create container '${spec.name}': ${created.stderr}`,
    );
  }
  const containerId = created.stdout.trim();
  if (!/^[a-f\d]{12,64}$/i.test(containerId)) {
    throw new Error(
      `Docker returned an invalid container ID for '${spec.name}'`,
    );
  }

  if (signal?.aborted) {
    await removeOwnedContainer(containerId, deps);
    throwIfAborted(signal);
  }

  let startRequested = false;
  let startFinished = false;
  let abortCleanup: Promise<void> | undefined;
  let resolveAbortedCleanup: (() => void) | undefined;
  let rejectAbortedCleanup: ((reason: unknown) => void) | undefined;
  const abortedCleanup = new Promise<void>((resolve, reject) => {
    resolveAbortedCleanup = resolve;
    rejectAbortedCleanup = reject;
  });
  const onAbort = () => {
    if (startRequested && !abortCleanup) {
      abortCleanup = stopOwnedContainer(containerId, deps, () => startFinished);
      // Install a rejection handler immediately while attach/start is pending.
      void abortCleanup.then(resolveAbortedCleanup, rejectAbortedCleanup);
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let exitCode = 1;
  let callbackError: unknown;
  try {
    throwIfAborted(signal);
    startRequested = true;
    const startArgs = [
      'start',
      '--attach',
      ...(spec.tty ? ['--interactive'] : []),
      containerId,
    ];
    const startPromise = deps.dockerSpawn(startArgs);
    if (signal) {
      const outcome = await Promise.race([
        startPromise.then(
          (code) => ({ code, kind: 'finished' as const }),
          (error: unknown) => ({ error, kind: 'failed' as const }),
        ),
        abortedCleanup.then(
          () => ({ kind: 'cancelled' as const }),
          (error: unknown) => ({ error, kind: 'cleanup-failed' as const }),
        ),
      ]);
      if (outcome.kind === 'finished') {
        exitCode = outcome.code;
      } else if (outcome.kind === 'failed') {
        callbackError = outcome.error;
      } else if (outcome.kind === 'cleanup-failed') {
        callbackError = outcome.error;
      } else {
        exitCode = 130;
      }
    } else {
      exitCode = await startPromise;
    }
  } catch (err) {
    callbackError = err;
  } finally {
    startFinished = true;
    signal?.removeEventListener('abort', onAbort);
  }

  // Cleanup is restricted to the ID returned by this invocation's successful
  // create. Proxy jobs always stop on return/detach. Non-proxy headless jobs
  // stop only for cancellation or an abnormal start/attach failure, preserving
  // their ordinary completion behavior.
  if (abortCleanup) {
    await abortCleanup;
  } else if (spec.proxyAuth || callbackError !== undefined) {
    await stopOwnedContainer(containerId, deps, () => startFinished);
  } else if (!spec.proxyAuth) {
    // A non-proxy headless run normally exits its container. If Docker returns
    // while the owned job is still active (e.g. an abnormal attach detach),
    // stop it; if start never left `created`, remove that owned object.
    const state = await inspectOwnedContainerState(
      containerId,
      deps.dockerExec,
    );
    if (state === 'created') {
      await removeOwnedContainer(containerId, deps);
    } else if (
      state === 'running' ||
      state === 'paused' ||
      state === 'restarting'
    ) {
      await stopOwnedContainer(containerId, deps, () => startFinished);
    }
  }
  if (callbackError !== undefined) {
    throw callbackError;
  }
  return exitCode;
}

const START_CANCELLATION_WAIT_MS = 30_000;

async function stopOwnedContainer(
  containerId: string,
  deps: RunnerDeps,
  startFinished: () => boolean,
  deadline = Date.now() + START_CANCELLATION_WAIT_MS,
): Promise<void> {
  const state = await inspectOwnedContainerState(containerId, deps.dockerExec);
  if (state === 'not_found' || state === 'exited' || state === 'dead') {
    return;
  }
  if (state === 'created') {
    if (startFinished()) {
      await removeOwnedContainer(containerId, deps);
      return;
    }
    if (Date.now() >= deadline) {
      // A Docker start process may still be racing this cancellation. Removing
      // this invocation's ID makes a late start fail rather than launch a job.
      await removeOwnedContainer(containerId, deps);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return stopOwnedContainer(containerId, deps, startFinished, deadline);
  }
  const stopped = await deps.dockerExec(['stop', '-t', '5', containerId]);
  if (stopped.exitCode !== 0) {
    throw new Error(
      `Failed to stop owned container '${containerId}': ${stopped.stderr}`,
    );
  }
  const finalState = await inspectOwnedContainerState(
    containerId,
    deps.dockerExec,
  );
  if (
    finalState === 'running' ||
    finalState === 'paused' ||
    finalState === 'restarting'
  ) {
    throw new Error(
      `Owned container '${containerId}' is still active after stop`,
    );
  }
}

async function removeOwnedContainer(
  containerId: string,
  deps: RunnerDeps,
): Promise<void> {
  const removed = await deps.dockerExec(['rm', '-f', containerId]);
  if (removed.exitCode !== 0 && !/no such container/i.test(removed.stderr)) {
    throw new Error(
      `Failed to remove owned container '${containerId}': ${removed.stderr}`,
    );
  }
}

async function inspectOwnedContainerState(
  name: string,
  dockerExecFn: DockerExecFn,
): Promise<ContainerLifecycle> {
  const result = await dockerExecFn([
    'inspect',
    '--format',
    '{{.State.Status}}',
    name,
  ]);
  if (result.exitCode !== 0) {
    if (/no such container/i.test(result.stderr)) {
      return 'not_found';
    }
    throw new Error(
      `Failed to inspect owned container '${name}': ${result.stderr}`,
    );
  }
  const status = result.stdout.trim();
  const lifecycle = CONTAINER_LIFECYCLES.find(
    (candidate) => candidate === status,
  );
  if (lifecycle) {
    return lifecycle;
  }
  throw new Error(
    `Unexpected lifecycle state for owned container '${name}': ${status}`,
  );
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
