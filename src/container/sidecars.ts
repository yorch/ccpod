import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const SIDECAR_ROLLBACK_TIMEOUT_MS = 5000;

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

export function validateServiceDependencies(
  services: Record<string, ServiceConfig>,
): [string, ServiceConfig][] {
  const names = Object.keys(services).sort();
  for (const name of names) {
    const service = services[name];
    if (!service) {
      continue;
    }
    for (const dependency of service.dependsOn ?? []) {
      if (!Object.hasOwn(services, dependency)) {
        throw new Error(
          `Sidecar '${name}' depends on missing service '${dependency}'`,
        );
      }
    }
  }

  const ordered: [string, ServiceConfig][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) {
      throw new Error(`Sidecar dependency cycle includes '${name}'`);
    }
    if (visited.has(name)) {
      return;
    }
    visiting.add(name);
    const service = services[name];
    if (!service) {
      return;
    }
    for (const dependency of [...(service.dependsOn ?? [])].sort()) {
      visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push([name, service]);
  };
  for (const name of names) {
    visit(name);
  }
  return ordered;
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

  // Complete graph validation before network inspection/creation (any Docker effects).
  const orderedServices = validateServiceDependencies(services);
  await ensureNetwork(networkName);

  const createdIds: string[] = [];
  try {
    for (const [serviceName, svc] of orderedServices) {
      const containerName = sidecarContainerName(
        profileName,
        projectHash,
        serviceName,
      );
      const createdId = await startSidecar(
        containerName,
        svc,
        networkName,
        profileName,
        projectHash,
        serviceName,
      );
      if (createdId) {
        createdIds.push(createdId);
      }
    }
  } catch (err) {
    const failedCreateId = (err as Error & { createdId?: string }).createdId;
    if (failedCreateId) {
      createdIds.push(failedCreateId);
    }
    for (const id of createdIds.reverse()) {
      await dockerExec(['rm', '-f', id], undefined, {
        timeoutMs: SIDECAR_ROLLBACK_TIMEOUT_MS,
      }).catch(() => {});
    }
    // The shared network is intentionally left in place; it may be shared by a sibling run.
    throw err;
  }
}

export async function removeSidecarNetwork(networkName: string): Promise<void> {
  const { exitCode, stderr } = await dockerExec(['network', 'rm', networkName]);
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
  const { exitCode: recheck } = await dockerExec(['network', 'inspect', name]);
  if (recheck === 0) {
    return;
  }
  throw new Error(`Failed to create network ${name}: ${stderr}`);
}

type ContainerStatus = {
  health: string;
  healthcheck: boolean;
  id: string;
  state: string;
};

async function inspectSidecar(
  containerRef: string,
  timeoutMs?: number,
): Promise<ContainerStatus | undefined> {
  const { exitCode, stdout } = await dockerExec(
    [
      'inspect',
      '--format',
      '{{.Id}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{if .Config.Healthcheck}}yes{{end}}',
      containerRef,
    ],
    undefined,
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  if (exitCode !== 0) {
    return undefined;
  }
  const [id, state, health = '', healthcheck = ''] = stdout.trim().split('|');
  return {
    health,
    healthcheck: healthcheck === 'yes',
    id: id ?? '',
    state: state ?? '',
  };
}

// Returns the newly-created Docker ID, or undefined when a running container is reused.
async function startSidecar(
  containerName: string,
  svc: ServiceConfig,
  networkName: string,
  profileName: string,
  projectHash: string,
  serviceName: string,
): Promise<string | undefined> {
  const timeoutSeconds = svc.ready?.timeoutSeconds ?? 60;
  const readinessDeadline = Date.now() + timeoutSeconds * 1000;
  const existing = await inspectSidecar(
    containerName,
    svc.ready
      ? remainingTimeout(readinessDeadline, serviceName, timeoutSeconds)
      : undefined,
  );
  if (existing?.state === 'running') {
    console.log(`  Sidecar already running: ${chalk.cyan(serviceName)}`);
    if (svc.ready) {
      await waitUntilReady(
        existing.id,
        serviceName,
        readinessDeadline,
        timeoutSeconds,
      );
    }
    return undefined;
  }
  if (existing) {
    await dockerExec(
      ['rm', '-f', existing.id || containerName],
      undefined,
      svc.ready
        ? {
            timeoutMs: remainingTimeout(
              readinessDeadline,
              serviceName,
              timeoutSeconds,
            ),
          }
        : {},
    );
  }

  const args = [
    'create',
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
  const sidecarEnv: Record<string, string> = {};
  for (const [rawK, v] of Object.entries(svc.env ?? {})) {
    const k = rawK.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      console.warn(
        `Warning: sidecar '${serviceName}' env key '${rawK}' is not a valid identifier — ignoring it.`,
      );
      continue;
    }
    const upper = k.toUpperCase();
    if (upper.startsWith('CCPOD_') || upper.startsWith('DOCKER_')) {
      console.warn(
        `Warning: sidecar '${serviceName}' env key '${k}' is not allowed (would affect ccpod controls or redirect the docker client) — ignoring it.`,
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
  const attemptId = randomUUID();
  const cidDir = mkdtempSync(join(tmpdir(), 'ccpod-sidecar-cid-'));
  const cidFile = join(cidDir, 'container-id');
  args.push(
    '--label',
    `ccpod.sidecar-attempt=${attemptId}`,
    '--cidfile',
    cidFile,
    svc.image,
  );

  try {
    let createResult: { exitCode: number; stderr: string; stdout: string };
    try {
      createResult = await dockerExec(args, sidecarEnv, {
        ...(svc.ready
          ? {
              timeoutMs: remainingTimeout(
                readinessDeadline,
                serviceName,
                timeoutSeconds,
              ),
            }
          : {}),
      });
    } catch (err) {
      const createdId = await recoverCreatedSidecarId(cidFile, attemptId);
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        ...(createdId ? { createdId } : {}),
      });
    }

    const id = createResult.stdout.trim() || readContainerId(cidFile);
    if (createResult.exitCode !== 0 || !id) {
      const createdId = await recoverCreatedSidecarId(cidFile, attemptId);
      const error = new Error(
        `Failed to create sidecar '${serviceName}': ${createResult.stderr || `exit ${createResult.exitCode}`}`,
      ) as Error & { createdId?: string };
      if (createdId) {
        error.createdId = createdId;
      }
      throw error;
    }

    let startResult: { exitCode: number; stderr: string };
    try {
      startResult = await dockerExec(['start', id], undefined, {
        ...(svc.ready
          ? {
              timeoutMs: remainingTimeout(
                readinessDeadline,
                serviceName,
                timeoutSeconds,
              ),
            }
          : {}),
      });
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        createdId: id,
      });
    }
    if (startResult.exitCode !== 0) {
      // The create ID is owned even when starting fails; roll back by ID, never by name.
      throw Object.assign(
        new Error(
          `Failed to start sidecar '${serviceName}': ${startResult.stderr || `exit ${startResult.exitCode}`}`,
        ),
        { createdId: id },
      );
    }
    console.log(`  Started sidecar: ${chalk.cyan(serviceName)}`);
    if (svc.ready) {
      try {
        await waitUntilReady(
          id,
          serviceName,
          readinessDeadline,
          timeoutSeconds,
        );
      } catch (err) {
        throw Object.assign(
          err instanceof Error ? err : new Error(String(err)),
          {
            createdId: id,
          },
        );
      }
    }
    return id;
  } finally {
    rmSync(cidDir, { force: true, recursive: true });
  }
}

function readinessTimeoutError(
  serviceName: string,
  timeoutSeconds: number,
): Error {
  return new Error(
    `Timed out waiting for sidecar '${serviceName}' readiness after ${timeoutSeconds}s`,
  );
}

function remainingTimeout(
  deadline: number,
  serviceName: string,
  timeoutSeconds: number,
): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw readinessTimeoutError(serviceName, timeoutSeconds);
  }
  return Math.max(1, Math.ceil(remaining));
}

const DOCKER_ID_RE = /^[a-f\d]{12,64}$/i;

function readContainerId(path: string): string | undefined {
  try {
    const id = readFileSync(path, 'utf8').trim();
    return DOCKER_ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

async function recoverCreatedSidecarId(
  cidFile: string,
  attemptId: string,
): Promise<string | undefined> {
  const fromFile = readContainerId(cidFile);
  if (fromFile) {
    return fromFile;
  }
  try {
    const { exitCode, stdout } = await dockerExec(
      ['ps', '-aq', '--filter', `label=ccpod.sidecar-attempt=${attemptId}`],
      undefined,
      { timeoutMs: 1000 },
    );
    const ids = stdout
      .trim()
      .split(/\s+/)
      .filter((id) => DOCKER_ID_RE.test(id));
    return exitCode === 0 && ids.length === 1 ? ids[0] : undefined;
  } catch {
    // Never guess by container name after an ambiguous create result.
    return undefined;
  }
}

async function waitUntilReady(
  containerId: string,
  serviceName: string,
  deadline: number,
  timeoutSeconds: number,
): Promise<void> {
  while (true) {
    if (Date.now() >= deadline) {
      throw readinessTimeoutError(serviceName, timeoutSeconds);
    }
    let status: ContainerStatus | undefined;
    try {
      status = await inspectSidecar(
        containerId,
        remainingTimeout(deadline, serviceName, timeoutSeconds),
      );
    } catch (err) {
      if (Date.now() >= deadline) {
        throw readinessTimeoutError(serviceName, timeoutSeconds);
      }
      throw err;
    }
    if (Date.now() >= deadline) {
      throw readinessTimeoutError(serviceName, timeoutSeconds);
    }
    if (!status) {
      throw new Error(
        `Sidecar '${serviceName}' disappeared while waiting for readiness`,
      );
    }
    if (status.state !== 'running') {
      throw new Error(
        `Sidecar '${serviceName}' exited while waiting for readiness (state: ${status.state})`,
      );
    }
    if (!status.healthcheck) {
      throw new Error(
        `Sidecar '${serviceName}' has no configured image healthcheck`,
      );
    }
    if (status.health === 'healthy') {
      return;
    }
    if (status.health === 'unhealthy') {
      throw new Error(`Sidecar '${serviceName}' became unhealthy`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
