import type Docker from "dockerode";
import { getDockerClient } from "../runtime/client.ts";
import type { ContainerSpec } from "./builder.ts";

export async function runContainer(spec: ContainerSpec): Promise<number> {
  const docker = await getDockerClient();

  // Reuse if already running, clean up if stopped
  const existing = await findContainer(docker, spec.name);
  if (existing) {
    const info = await existing.inspect();
    if (info.State.Running) {
      console.log(`Reattaching to running container: ${spec.name}`);
      return attach(existing, spec.tty);
    }
    await existing.remove();
  }

  const container = await docker.createContainer({
    Image: spec.image,
    name: spec.name,
    WorkingDir: spec.workingDir,
    Env: spec.env,
    Tty: spec.tty,
    OpenStdin: spec.openStdin,
    AttachStdin: spec.openStdin,
    AttachStdout: true,
    AttachStderr: true,
    Labels: spec.labels,
    HostConfig: {
      Binds: spec.binds,
      PortBindings: spec.portBindings,
      NetworkMode: spec.networkMode,
      Tmpfs: spec.tmpfs ?? {},
    },
  });

  return spec.tty ? runInteractive(container) : runHeadless(container);
}

export async function stopContainer(name: string): Promise<void> {
  const docker = await getDockerClient();
  const container = await findContainer(docker, name);
  if (!container) return;
  const info = await container.inspect();
  if (info.State.Running) await container.stop();
  await container.remove();
}

async function runInteractive(container: Docker.Container): Promise<number> {
  const stream = await container.attach({
    stream: true,
    stdin: true,
    stdout: true,
    stderr: true,
    hijack: true,
  });

  await container.start();

  if (process.stdout.columns && process.stdout.rows) {
    await container.resize({ w: process.stdout.columns, h: process.stdout.rows }).catch(() => {});
  }

  if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.pipe(stream as NodeJS.WritableStream);
  (stream as NodeJS.ReadableStream).pipe(process.stdout);

  const onResize = () => {
    if (process.stdout.columns && process.stdout.rows) {
      container.resize({ w: process.stdout.columns, h: process.stdout.rows }).catch(() => {});
    }
  };
  process.stdout.on("resize", onResize);

  const { StatusCode } = await container.wait();

  process.stdout.removeListener("resize", onResize);
  if (process.stdin.isTTY) process.stdin.setRawMode?.(false);

  return StatusCode;
}

async function runHeadless(container: Docker.Container): Promise<number> {
  await container.start();

  const logStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
  });

  container.modem.demuxStream(logStream as NodeJS.ReadableStream, process.stdout, process.stderr);

  const { StatusCode } = await container.wait();
  return StatusCode;
}

async function attach(container: Docker.Container, tty: boolean): Promise<number> {
  return tty ? runInteractive(container) : runHeadless(container);
}

async function findContainer(
  docker: Docker,
  name: string,
): Promise<Docker.Container | null> {
  try {
    const c = docker.getContainer(name);
    await c.inspect();
    return c;
  } catch {
    return null;
  }
}
