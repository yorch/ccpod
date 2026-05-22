import chalk from 'chalk';
import { dockerExec } from '../runtime/docker.ts';
import type { ServiceConfig } from '../types/index.ts';
import { VERSION } from '../version.ts';
import {
  LABEL_PROFILE,
  LABEL_PROJECT,
  LABEL_TYPE,
  LABEL_VERSION,
} from './builder.ts';

export function sidecarNetworkName(projectHash: string): string {
  return `ccpod-net-${projectHash}`;
}

function sidecarContainerName(
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
  const entries = Object.entries(services);
  if (entries.length === 0) {
    return;
  }

  await ensureNetwork(networkName);

  // Track containers we actually started (not pre-existing reattachments) so
  // that a partial failure can roll everything else back.
  const started: string[] = [];
  try {
    const results = await Promise.all(
      entries.map(async ([serviceName, svc]) => {
        const containerName = sidecarContainerName(
          profileName,
          projectHash,
          serviceName,
        );
        const wasStarted = await startSidecar(
          containerName,
          svc,
          networkName,
          profileName,
          projectHash,
          serviceName,
        );
        return { containerName, wasStarted };
      }),
    );
    for (const r of results) {
      if (r.wasStarted) {
        started.push(r.containerName);
      }
    }
  } catch (err) {
    // Roll back containers we started during this invocation. Best-effort —
    // surface the original error, log secondary failures but don't shadow it.
    for (const name of started) {
      const stop = await dockerExec(['stop', '-t', '2', name]);
      if (stop.exitCode !== 0 && !/no such container/i.test(stop.stderr)) {
        console.warn(
          `  Failed to roll back sidecar ${name}: ${stop.stderr.trim()}`,
        );
      }
      await dockerExec(['rm', '-f', name]);
    }
    throw err;
  }
}

export async function removeSidecarNetwork(
  networkName: string,
): Promise<{ ok: boolean; stderr: string }> {
  const { exitCode, stderr } = await dockerExec(['network', 'rm', networkName]);
  return { ok: exitCode === 0, stderr };
}

async function ensureNetwork(name: string): Promise<void> {
  const { exitCode } = await dockerExec(['network', 'inspect', name]);
  if (exitCode === 0) {
    return;
  }
  const { exitCode: createCode, stderr } = await dockerExec([
    'network',
    'create',
    name,
  ]);
  if (createCode === 0) {
    return;
  }
  // A concurrent `ccpod run` may have created the network between our inspect
  // and create. Docker reports this as "already exists" — accept it. Otherwise
  // confirm by re-inspecting (covers races where the error wording differs).
  if (/already exists/i.test(stderr)) {
    return;
  }
  const recheck = await dockerExec(['network', 'inspect', name]);
  if (recheck.exitCode === 0) {
    return;
  }
  throw new Error(`Failed to create network ${name}: ${stderr}`);
}

async function startSidecar(
  containerName: string,
  svc: ServiceConfig,
  networkName: string,
  profileName: string,
  projectHash: string,
  serviceName: string,
): Promise<boolean> {
  const { exitCode, stdout } = await dockerExec([
    'inspect',
    '--format',
    '{{.State.Status}}',
    containerName,
  ]);

  if (exitCode === 0) {
    if (stdout === 'running') {
      console.log(`  Sidecar already running: ${chalk.cyan(serviceName)}`);
      return false;
    }
    const rm = await dockerExec(['rm', containerName]);
    if (rm.exitCode !== 0 && !/no such container/i.test(rm.stderr)) {
      throw new Error(
        `Failed to remove stale sidecar '${serviceName}': ${rm.stderr}`,
      );
    }
  }

  const args = [
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    networkName,
    '--label',
    `${LABEL_PROFILE}=${profileName}`,
    '--label',
    `${LABEL_PROJECT}=${projectHash}`,
    '--label',
    `${LABEL_TYPE}=${serviceName}`,
    '--label',
    `${LABEL_VERSION}=${VERSION}`,
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
  return true;
}
