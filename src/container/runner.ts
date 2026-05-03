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
    console.log(`Reattaching to running container: ${spec.name}`);
    return deps.dockerSpawn(['attach', spec.name]);
  }

  if (state === 'stopped') {
    const { exitCode, stderr } = await deps.dockerExec(['rm', spec.name]);
    if (exitCode !== 0) {
      throw new Error(
        `Failed to remove stopped container '${spec.name}': ${stderr}`,
      );
    }
  }

  return deps.dockerSpawn(buildRunArgs(spec));
}

export async function stopContainer(
  name: string,
  deps: RunnerDeps = defaultDeps(),
): Promise<void> {
  const state = await containerState(name, deps.dockerExec);
  if (state === 'not_found') {
    return;
  }
  if (state === 'running') {
    await deps.dockerExec(['stop', '-t', '5', name]);
  }
  await deps.dockerExec(['rm', name]);
}

async function containerState(
  name: string,
  dockerExecFn: DockerExecFn,
): Promise<'running' | 'stopped' | 'not_found'> {
  const { exitCode, stdout } = await dockerExecFn([
    'inspect',
    '--format',
    '{{.State.Status}}',
    name,
  ]);
  if (exitCode !== 0) {
    return 'not_found';
  }
  return stdout === 'running' ? 'running' : 'stopped';
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
    for (const hb of bindings) {
      args.push('-p', `${hb.HostPort}:${containerPort.replace('/tcp', '')}`);
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
