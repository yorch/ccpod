import { dockerExec } from '../runtime/docker.ts';
import { LABEL_PROFILE, LABEL_PROJECT, LABEL_WORKDIR } from './builder.ts';

export interface CcpodContainer {
  id: string;
  image: string;
  name: string;
  profile: string;
  project: string;
  running: boolean;
  /** Docker lifecycle state: running, paused, restarting, exited, created, dead, removing. */
  state: string;
  status: string;
  workdir: string;
}

export interface ListFilter {
  /** Include stopped containers (default: running only). */
  all?: boolean;
  profile?: string;
  project?: string;
}

// Tab can't appear in a container id/name/state/image or a ccpod label value
// we wrote ourselves, unlike ',' or '|' (workdir paths may contain either).
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
  args.push('--format', FORMAT);

  const { exitCode, stderr, stdout } = await exec(args);
  if (exitCode !== 0) {
    throw new Error(`docker ps failed: ${stderr || 'unknown error'}`);
  }

  return stdout
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
        workdir,
      };
    })
    .filter((c) => c.id !== '');
}
