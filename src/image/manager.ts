import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDockerClient } from "../runtime/client.ts";

export async function ensureImage(image: string, force = false): Promise<void> {
  const docker = await getDockerClient();

  if (!force) {
    try {
      await docker.getImage(image).inspect();
      return;
    } catch {
      // not found locally, fall through to pull
    }
  }

  await pullImage(image);
}

export async function buildImage(
  dockerfile: string,
  tag: string,
  contextDir: string,
): Promise<void> {
  const docker = await getDockerClient();
  const dockerfilePath = existsSync(join(contextDir, dockerfile))
    ? join(contextDir, dockerfile)
    : dockerfile;

  console.log(`Building image: ${tag}`);
  const stream = await docker.buildImage(
    { context: contextDir, src: [dockerfilePath] },
    { t: tag, dockerfile: dockerfilePath },
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (event: { stream?: string; error?: string }) => {
        if (event.stream) process.stdout.write(event.stream);
        if (event.error) process.stderr.write(event.error);
      },
    );
  });
}

async function pullImage(image: string): Promise<void> {
  const docker = await getDockerClient();
  console.log(`Pulling image: ${image}`);

  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    docker.pull(image, (err: Error | null, s: NodeJS.ReadableStream) => {
      if (err) reject(err);
      else resolve(s);
    });
  });

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (event: { status?: string; progress?: string }) => {
        if (event.progress) {
          process.stdout.write(`\r${event.status ?? ""} ${event.progress}   `);
        }
      },
    );
  });

  process.stdout.write("\n");
}
