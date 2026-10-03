import { rmSync } from 'node:fs';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadProfileConfig } from '../../../config/loader.ts';
import { computeProjectHash } from '../../../container/builder.ts';
import { listCcpodContainers } from '../../../container/list.ts';
import { getProfileDir, getStateDir } from '../../../profile/manager.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { exitWithError } from '../../errors.ts';
import { resolveProfileName } from '../../profile-arg.ts';

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
  meta: {
    description: 'Clear persistent state for a profile',
    name: 'clear',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    const profileName = resolveProfileName(args.profile);

    // Determine state isolation mode from the profile config
    const profile = loadProfileConfig(getProfileDir(profileName));
    const perProject = profile.stateIsolation === 'per-project';

    // In per-project mode (without --all), check only the current project's
    // container. Otherwise, check all containers for the profile.
    let projectHash: string | undefined;
    if (perProject && !args.all) {
      projectHash = computeProjectHash(process.cwd());
    }

    let running: Awaited<ReturnType<typeof listCcpodContainers>>;
    try {
      running = await listCcpodContainers({
        profile: profileName,
        ...(projectHash ? { project: projectHash } : {}),
      });
    } catch (err) {
      // Can't tell whether the state is in use — never delete it blind.
      exitWithError(err);
    }
    if (running.length > 0) {
      const scope = projectHash ? 'this project' : 'this profile';
      console.error(
        `A ccpod container for '${profileName}' (${scope}) is still running. Stop it first with: ccpod down`,
      );
      process.exit(1);
    }

    let stateDir: string;
    if (projectHash) {
      stateDir = getStateDir(profileName, projectHash);
    } else {
      stateDir = getStateDir(profileName);
    }

    if (!args.force) {
      const scope = perProject && !args.all ? 'this project' : 'all projects';
      const ok = await confirm({
        default: false,
        message: `Remove state at ${chalk.cyan(stateDir)}? This deletes saved projects, todos, and conversation history for ${scope}.`,
      });
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    process.stdout.write(`Removing ${chalk.cyan(stateDir)}... `);
    rmSync(stateDir, { force: true, recursive: true });
    console.log(chalk.green('done'));
  },
});
