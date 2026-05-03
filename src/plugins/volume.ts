import { dockerExec } from '../runtime/docker.ts';

export function pluginsVolumeName(profileName: string): string {
  return `ccpod-plugins-${profileName}`;
}

export async function volumeExists(name: string): Promise<boolean> {
  const { exitCode } = await dockerExec(['volume', 'inspect', name]);
  return exitCode === 0;
}

export async function removeVolume(name: string): Promise<void> {
  const { exitCode, stderr } = await dockerExec(['volume', 'rm', name]);
  if (exitCode !== 0) {
    throw new Error(`docker volume rm failed: ${stderr}`);
  }
}

export async function listVolumeEntries(
  volumeName: string,
  mountPath: string,
): Promise<string[]> {
  const { stdout } = await dockerExec([
    'run',
    '--rm',
    '-v',
    `${volumeName}:${mountPath}:ro`,
    'alpine',
    'sh',
    '-c',
    `ls -1 "${mountPath}" 2>/dev/null || true`,
  ]);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '.' && l !== '..');
}
