import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dockerExec, dockerSpawn } from '../runtime/docker.ts';

type DockerExecFn = typeof dockerExec;
type DockerSpawnFn = typeof dockerSpawn;

export interface ImageDeps {
  dockerExec: DockerExecFn;
  dockerSpawn: DockerSpawnFn;
}

const defaultDeps: ImageDeps = { dockerExec, dockerSpawn };

export async function ensureImage(
  image: string,
  force = false,
  deps: ImageDeps = defaultDeps,
): Promise<void> {
  if (!force) {
    const { exitCode } = await deps.dockerExec(['image', 'inspect', image]);
    if (exitCode === 0) {
      return;
    }
  }
  await pullImage(image, deps);
}

export async function buildImage(
  dockerfile: string,
  tag: string,
  contextDir: string,
  deps: ImageDeps = defaultDeps,
): Promise<void> {
  const dockerfilePath = existsSync(join(contextDir, dockerfile))
    ? join(contextDir, dockerfile)
    : dockerfile;

  console.log(`Building image: ${tag}`);
  const exitCode = await deps.dockerSpawn([
    'build',
    '-f',
    dockerfilePath,
    '-t',
    tag,
    contextDir,
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker build failed (exit ${exitCode})`);
  }
}

export async function ensureLocalImage(
  tag: string,
  dockerfile: string,
  contextDir: string,
  force = false,
  deps: ImageDeps = defaultDeps,
): Promise<void> {
  if (!force) {
    const { exitCode } = await deps.dockerExec(['image', 'inspect', tag]);
    if (exitCode === 0) {
      return;
    }
  }
  await buildImage(dockerfile, tag, contextDir, deps);
}

async function pullImage(image: string, deps: ImageDeps): Promise<void> {
  console.log(`Pulling image: ${image}`);
  const exitCode = await deps.dockerSpawn(['pull', image]);
  if (exitCode !== 0) {
    throw new Error(`docker pull failed (exit ${exitCode})`);
  }
}
