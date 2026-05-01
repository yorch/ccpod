import chalk from 'chalk';
import { dockerExec } from '../runtime/docker.ts';
import type { ServiceConfig } from '../types/index.ts';
import { VERSION } from '../version.ts';

export function sidecarNetworkName(projectHash: string): string {
  return `ccpod-net-${projectHash}`;
}

export function sidecarContainerName(
  profileName: string,
  projectHash: string,
  serviceName: string,
): string {
  return `ccpod-svc-${profileName}-${projectHash}-${serviceName}`;
}

export async function startSidecars(
  services: Record<string, ServiceConfig>,
  networkName: string,
  profileName: string,
  projectHash: string,
): Promise<void> {
  if (Object.keys(services).length === 0) return;

  await ensureNetwork(networkName);

  for (const [serviceName, svc] of Object.entries(services)) {
    const containerName = sidecarContainerName(
      profileName,
      projectHash,
      serviceName,
    );
    await startSidecar(
      containerName,
      svc,
      networkName,
      profileName,
      projectHash,
      serviceName,
    );
  }
}

export async function removeSidecarNetwork(networkName: string): Promise<void> {
  await dockerExec(['network', 'rm', networkName]);
}

async function ensureNetwork(name: string): Promise<void> {
  const { exitCode } = await dockerExec(['network', 'inspect', name]);
  if (exitCode === 0) return;
  const { exitCode: createCode, stderr } = await dockerExec([
    'network',
    'create',
    name,
  ]);
  if (createCode !== 0)
    throw new Error(`Failed to create network ${name}: ${stderr}`);
}

async function startSidecar(
  containerName: string,
  svc: ServiceConfig,
  networkName: string,
  profileName: string,
  projectHash: string,
  serviceName: string,
): Promise<void> {
  const { exitCode, stdout } = await dockerExec([
    'inspect',
    '--format',
    '{{.State.Status}}',
    containerName,
  ]);

  if (exitCode === 0) {
    if (stdout === 'running') {
      console.log(`  Sidecar already running: ${chalk.cyan(serviceName)}`);
      return;
    }
    await dockerExec(['rm', containerName]);
  }

  const args = [
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    networkName,
    '--label',
    `ccpod.profile=${profileName}`,
    '--label',
    `ccpod.project=${projectHash}`,
    '--label',
    `ccpod.type=${serviceName}`,
    '--label',
    `ccpod.version=${VERSION}`,
  ];

  for (const [k, v] of Object.entries(svc.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  for (const vol of svc.volumes ?? []) {
    args.push('-v', vol);
  }
  for (const port of svc.ports ?? []) {
    args.push('-p', port);
  }

  args.push(svc.image);

  const { exitCode: runCode, stderr } = await dockerExec(args);
  if (runCode !== 0) {
    throw new Error(
      `Failed to start sidecar '${serviceName}': ${stderr || `exit ${runCode}`}`,
    );
  }

  console.log(`  Started sidecar: ${chalk.cyan(serviceName)}`);
}
