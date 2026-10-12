import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadProfileConfig } from '../../../config/loader.ts';
import { computeProjectHash } from '../../../container/builder.ts';
import { listCcpodContainers } from '../../../container/list.ts';
import { getCcpodHome, getProfileDir } from '../../../profile/manager.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { exitWithError } from '../../errors.ts';
import { resolveProfileName } from '../../profile-arg.ts';

type StateFilter = Parameters<typeof listCcpodContainers>[0];
interface ClearDeps {
  confirmRemoval: () => Promise<boolean>;
  list: (filter: StateFilter) => ReturnType<typeof listCcpodContainers>;
  remove: () => void;
}
export async function clearStateSafely(
  profileName: string,
  scope: string,
  filter: StateFilter,
  force: boolean,
  deps: ClearDeps,
): Promise<boolean> {
  const verifyInactive = async () => {
    const containers = await deps.list(filter);
    const active = containers.find(
      (container) =>
        // Only the main and shell containers mount /ccpod/state. A running
        // sidecar (redis, postgres, ...) shares the profile label but never
        // touches this profile's conversation state, so it must not block
        // clearing it.
        (container.type === 'main' || container.type === 'shell') &&
        !['exited', 'dead', 'removing'].includes(container.state),
    );
    if (active) {
      throw new Error(
        `A ccpod container for '${profileName}' (${scope}) is ${active.state}. Stop it first with: ccpod down`,
      );
    }
  };
  await verifyInactive();
  if (!force) {
    const confirmed = await deps.confirmRemoval();
    if (!confirmed) {
      return false;
    }
  }
  // Re-query after confirmation (and also on --force) to close the race with a
  // container starting between the first check and deletion.
  await verifyInactive();
  deps.remove();
  return true;
}
export default defineCommand({
  args: {
    all: {
      default: false,
      description: 'Clear state for all projects (per-project isolation only)',
      type: 'boolean',
    },
    force: {
      alias: ['y', 'yes'],
      default: false,
      description: 'Skip confirmation prompt',
      type: 'boolean',
    },
    profile: { description: 'Profile name', type: 'string' },
  },
  meta: { description: 'Clear persistent state for a profile', name: 'clear' },
  async run({ args }) {
    rejectExtraPositionals(args);
    const profileName = resolveProfileName(args.profile);
    const profile = loadProfileConfig(getProfileDir(profileName));
    const perProject = profile.stateIsolation === 'per-project';
    const projectHash =
      perProject && !args.all ? computeProjectHash(process.cwd()) : undefined;
    const filter = {
      all: true,
      profile: profileName,
      ...(projectHash ? { project: projectHash } : {}),
    };
    const stateDir = projectHash
      ? join(getCcpodHome(), 'state', profileName, projectHash)
      : join(getCcpodHome(), 'state', profileName);
    const scope = perProject && !args.all ? 'this project' : 'this profile';
    let confirmed = false;
    try {
      confirmed = await clearStateSafely(
        profileName,
        scope,
        filter,
        args.force,
        {
          confirmRemoval: () =>
            confirm({
              default: false,
              message: `Remove state at ${chalk.cyan(stateDir)}? This deletes saved projects, todos, and conversation history for ${scope}.`,
            }),
          list: listCcpodContainers,
          remove: () => rmSync(stateDir, { force: true, recursive: true }),
        },
      );
    } catch (err) {
      exitWithError(err);
    }
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
    process.stdout.write(`Removing ${chalk.cyan(stateDir)}... `);
    console.log(chalk.green('done'));
  },
});
