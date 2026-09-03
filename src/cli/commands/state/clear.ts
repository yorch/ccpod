import { rmSync } from 'node:fs';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import {
  loadProfileConfig,
  loadProjectConfig,
} from '../../../config/loader.ts';
import { computeProjectHash } from '../../../container/builder.ts';
import {
  getProfileDir,
  getStateDir,
  profileExists,
} from '../../../profile/manager.ts';
import { dockerExec } from '../../../runtime/docker.ts';
import { validateProfileArg } from '../../validate.ts';

async function hasRunningContainer(
  profileName: string,
  projectHash?: string,
): Promise<boolean> {
  const filterArgs = [
    'ps',
    '--filter',
    `label=ccpod.profile=${profileName}`,
    '--filter',
    'status=running',
  ];
  if (projectHash) {
    filterArgs.push('--filter', `label=ccpod.project=${projectHash}`);
  }
  filterArgs.push('--quiet');
  const { stdout } = await dockerExec(filterArgs);
  return stdout.trim().length > 0;
}

export default defineCommand({
  args: {
    all: {
      default: false,
      description: 'Clear state for all projects (per-project isolation only)',
      type: 'boolean',
    },
    force: {
      default: false,
      description: 'Skip confirmation prompt',
      type: 'boolean',
    },
    profile: { description: 'Profile name', type: 'string' },
  },
  meta: { description: 'Clear persistent state for a profile' },
  async run({ args }) {
    validateProfileArg(args.profile);
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? 'default';

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    // Determine state isolation mode from the profile config
    const profile = loadProfileConfig(getProfileDir(profileName));
    const perProject = profile.stateIsolation === 'per-project';

    // In per-project mode (without --all), check only the current project's
    // container. Otherwise, check all containers for the profile.
    let projectHash: string | undefined;
    if (perProject && !args.all) {
      projectHash = computeProjectHash(process.cwd());
    }

    if (await hasRunningContainer(profileName, projectHash)) {
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
