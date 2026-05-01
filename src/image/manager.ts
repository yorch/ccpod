import { existsSync } from "node:fs";
import { join } from "node:path";
import { dockerExec, dockerSpawn } from "../runtime/docker.ts";

export async function ensureImage(image: string, force = false): Promise<void> {
  if (!force) {
    const { exitCode } = await dockerExec(["image", "inspect", image]);
    if (exitCode === 0) return;
  }
  await pullImage(image);
}

export async function buildImage(dockerfile: string, tag: string, contextDir: string): Promise<void> {
  const dockerfilePath = existsSync(join(contextDir, dockerfile))
    ? join(contextDir, dockerfile)
    : dockerfile;

  console.log(`Building image: ${tag}`);
  const exitCode = await dockerSpawn(["build", "-f", dockerfilePath, "-t", tag, contextDir]);
  if (exitCode !== 0) throw new Error(`docker build failed (exit ${exitCode})`);
}

async function pullImage(image: string): Promise<void> {
  console.log(`Pulling image: ${image}`);
  const exitCode = await dockerSpawn(["pull", image]);
  if (exitCode !== 0) throw new Error(`docker pull failed (exit ${exitCode})`);
}
