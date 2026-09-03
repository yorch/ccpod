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
  if (Object.keys(services).length === 0) {
    return;
  }

  await ensureNetwork(networkName);

  // Roll back the sidecars this call started if a later one fails, so a partial
  // failure doesn't leave orphaned containers behind (already-running sidecars
  // from a previous run are left untouched).
  const startedThisCall: string[] = [];
  try {
    for (const [serviceName, svc] of Object.entries(services)) {
      const containerName = sidecarContainerName(
        profileName,
        projectHash,
        serviceName,
      );
      const started = await startSidecar(
        containerName,
        svc,
        networkName,
        profileName,
        projectHash,
        serviceName,
      );
      if (started) {
        startedThisCall.push(containerName);
      }
    }
  } catch (err) {
    for (const containerName of startedThisCall.reverse()) {
      await dockerExec(['rm', '-f', containerName]).catch(() => {});
    }
    // The shared network is intentionally left in place: it is idempotent,
    // adopted by the next run's ensureNetwork, and removed by `ccpod down` once
    // no containers reference it. Removing it here could disrupt a sibling run.
    throw err;
  }
}

export async function removeSidecarNetwork(networkName: string): Promise<void> {
  const { exitCode, stderr } = await dockerExec(['network', 'rm', networkName]);
  // A network that is already gone is fine; anything else (e.g. still-attached
  // endpoints) is worth surfacing rather than swallowing silently.
  if (exitCode !== 0 && !/no such network/i.test(stderr)) {
    console.warn(`Warning: failed to remove network ${networkName}: ${stderr}`);
  }
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
  // A concurrent `ccpod run` in the same project may have created the network
  // between our inspect and create (docker returns a name/id conflict). Re-check
  // before failing so the race resolves to success rather than aborting a run.
  const { exitCode: recheck } = await dockerExec(['network', 'inspect', name]);
  if (recheck === 0) {
    return;
  }
  throw new Error(`Failed to create network ${name}: ${stderr}`);
}

// Returns true if this call started a new container (so the caller can roll it
// back on a later failure), false if an already-running sidecar was reused.
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
    if (stdout.trim() === 'running') {
      console.log(`  Sidecar already running: ${chalk.cyan(serviceName)}`);
      return false;
    }
    // Replace a stale sidecar (exited/paused/restarting). `-f` handles the
    // paused/restarting states that a plain `rm` would reject.
    await dockerExec(['rm', '-f', containerName]);
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

  // Sidecar env values are passed as bare `-e KEY` flags with the values
  // injected into docker's own environment via extraEnv — matching the
  // main-container pattern so secrets don't appear in `ps` / cmdline.
  // Keys are validated and filtered: a key containing `=` would turn the bare
  // `-e KEY` into a literal `-e KEY=VALUE` in argv (leaking the value), and
  // CCPOD_*/DOCKER_* keys could override ccpod control vars or redirect the
  // docker CLI itself via extraEnv.
  const sidecarEnv: Record<string, string> = {};
  for (const [rawK, v] of Object.entries(svc.env ?? {})) {
    const k = rawK.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      console.warn(
        `Warning: sidecar '${serviceName}' env key '${rawK}' is not a valid ` +
          'identifier — ignoring it.',
      );
      continue;
    }
    const upper = k.toUpperCase();
    if (upper.startsWith('CCPOD_') || upper.startsWith('DOCKER_')) {
      console.warn(
        `Warning: sidecar '${serviceName}' env key '${k}' is not allowed ` +
          '(would affect ccpod controls or redirect the docker client) ' +
          '— ignoring it.',
      );
      continue;
    }
    args.push('-e', k);
    sidecarEnv[k] = v;
  }
  for (const vol of svc.volumes ?? []) {
    args.push('-v', vol);
  }
  for (const port of svc.ports ?? []) {
    args.push('-p', port);
  }

  args.push(svc.image);

  const { exitCode: runCode, stderr } = await dockerExec(args, sidecarEnv);
  if (runCode !== 0) {
    throw new Error(
      `Failed to start sidecar '${serviceName}': ${stderr || `exit ${runCode}`}`,
    );
  }

  console.log(`  Started sidecar: ${chalk.cyan(serviceName)}`);
  return true;
}
