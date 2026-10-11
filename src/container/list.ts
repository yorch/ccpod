import { dockerExec } from '../runtime/docker.ts';
import {
  LABEL_PROFILE,
  LABEL_PROJECT,
  LABEL_TYPE,
  LABEL_WORKDIR,
} from './builder.ts';

export interface CcpodContainer {
  exitCode?: number | null;
  health?: string | null;
  id: string;
  image: string;
  name: string;
  profile: string;
  project: string;
  running: boolean;
  /** Docker lifecycle state: running, paused, restarting, exited, created, dead, removing. */
  state: string;
  status: string;
  type: string;
  workdir: string;
}

export interface ListFilter {
  /** Include stopped containers (default: running only). */
  all?: boolean;
  /** Inspect lifecycle details (failures produce null detail fields). */
  details?: boolean;
  profile?: string;
  project?: string;
  service?: string;
}

// Tab can't appear in a container id/name/state/image or a ccpod label value,
// unlike ',' or '|' (workdir paths may contain either).
const SEP = '\t';
const FORMAT = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.State}}',
  '{{.Image}}',
  '{{.Status}}',
  `{{.Label "${LABEL_PROFILE}"}}`,
  `{{.Label "${LABEL_PROJECT}"}}`,
  `{{.Label "${LABEL_WORKDIR}"}}`,
  `{{.Label "${LABEL_TYPE}"}}`,
].join(SEP);

/**
 * List ccpod-labelled containers. Throws when docker itself fails — callers
 * such as `down`, `state clear` and `prune` make destructive decisions from
 * the result, and "docker unreachable" must not look like "nothing running".
 */
export async function listCcpodContainers(
  filter: ListFilter = {},
  exec: typeof dockerExec = dockerExec,
): Promise<CcpodContainer[]> {
  const args = ['ps'];
  if (filter.all) {
    args.push('-a');
  }
  args.push('--filter', `label=${LABEL_PROFILE}`);
  if (filter.profile) {
    args.push('--filter', `label=${LABEL_PROFILE}=${filter.profile}`);
  }
  if (filter.project) {
    args.push('--filter', `label=${LABEL_PROJECT}=${filter.project}`);
  }
  if (filter.service) {
    args.push('--filter', `label=${LABEL_TYPE}=${filter.service}`);
  }
  args.push('--format', FORMAT);

  const { exitCode, stderr, stdout } = await exec(args);
  if (exitCode !== 0) {
    throw new Error(`docker ps failed: ${stderr || 'unknown error'}`);
  }

  const containers: CcpodContainer[] = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [
        id = '',
        name = '',
        state = '',
        image = '',
        status = '',
        profile = '',
        project = '',
        workdir = '',
        type = '',
      ] = line.split(SEP);
      return {
        id,
        image,
        name: name.replace(/^\//, ''),
        profile,
        project,
        running: state === 'running',
        state,
        status,
        type,
        workdir,
      } satisfies CcpodContainer;
    })
    .filter((container) => container.id !== '');

  if (filter.details) {
    await Promise.all(
      containers.map(async (container) => {
        const result = await exec([
          'inspect',
          '--format',
          '{{.State.ExitCode}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
          container.id,
        ]).catch(() => null);
        if (!result || result.exitCode !== 0) {
          container.exitCode = null;
          container.health = null;
          return;
        }
        const [exit, health] = result.stdout.split(SEP);
        container.exitCode = /^-?\d+$/.test(exit ?? '') ? Number(exit) : null;
        container.health = health === 'none' ? null : health || null;
      }),
    );
  }
  return containers;
}
