import { getDockerClient } from "../runtime/client.ts";

export function pluginsVolumeName(profileName: string): string {
  return `ccpod-plugins-${profileName}`;
}

export function stateVolumeName(profileName: string): string {
  return `ccpod-state-${profileName}`;
}

export async function volumeExists(name: string): Promise<boolean> {
  const docker = await getDockerClient();
  try {
    await docker.getVolume(name).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function removeVolume(name: string): Promise<void> {
  const docker = await getDockerClient();
  await docker.getVolume(name).remove();
}

/** Lists entries in a Docker named volume by running a disposable alpine container. */
export async function listVolumeEntries(volumeName: string, mountPath: string): Promise<string[]> {
  const docker = await getDockerClient();

  const container = await docker.createContainer({
    Image: "alpine",
    Cmd: ["sh", "-c", `ls -1 "${mountPath}" 2>/dev/null || true`],
    AttachStdout: true,
    AttachStderr: false,
    HostConfig: {
      Binds: [`${volumeName}:${mountPath}:ro`],
      AutoRemove: false,
    },
  });

  try {
    await container.start();
    const logStream = await container.logs({ stdout: true, stderr: false, follow: true });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      (logStream as NodeJS.ReadableStream).on("data", (chunk: Buffer) => chunks.push(chunk));
      (logStream as NodeJS.ReadableStream).on("end", resolve);
    });
    await container.wait();

    // Docker log stream prepends an 8-byte header per frame; strip it
    const raw = Buffer.concat(chunks);
    const lines: string[] = [];
    let offset = 0;
    while (offset + 8 <= raw.length) {
      const size = raw.readUInt32BE(offset + 4);
      const line = raw.slice(offset + 8, offset + 8 + size).toString("utf8").trim();
      if (line) lines.push(...line.split("\n").filter(Boolean));
      offset += 8 + size;
    }
    return lines.filter((l) => l !== "." && l !== "..");
  } finally {
    await container.remove().catch(() => {});
  }
}
