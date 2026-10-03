import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { listCcpodContainers } from '../../../container/list.ts';
import {
  pluginsVolumeName,
  removeVolume,
  volumeExists,
} from '../../../plugins/volume.ts';
import { deleteProfile, profileExists } from '../../../profile/manager.ts';
import { exitWithError } from '../../errors.ts';
import { validateProfileArg } from '../../validate.ts';

export default defineCommand({
  args: {
    force: {
      alias: ['y', 'yes'],
      default: false,
      description: 'Skip confirmation prompt',
      type: 'boolean',
    },
    name: {
      description: 'Profile name',
      required: true,
      type: 'positional',
    },
  },
  meta: { description: 'Delete a profile', name: 'delete' },
  async run({ args }) {
    if (!args.name) {
      console.error('Profile name required.');
      process.exit(1);
    }
    validateProfileArg(args.name);

    if (!profileExists(args.name)) {
      console.error(`Profile '${args.name}' not found.`);
      process.exit(1);
    }

    // A container using this profile's credentials/state must not be left
    // running against directories we're about to delete. If docker is
    // unreachable we can't tell, so don't guess: ask the user to retry.
    let containers: Awaited<ReturnType<typeof listCcpodContainers>>;
    try {
      containers = await listCcpodContainers({
        all: true,
        profile: args.name,
      });
    } catch (err) {
      exitWithError(err);
    }
    if (containers.some((c) => c.running)) {
      exitWithError(
        new Error(
          `Profile '${args.name}' has running containers. Stop them first with: ccpod down --profile ${args.name}`,
        ),
      );
    }

    if (!args.force) {
      const ok = await confirm({
        default: false,
        message: `Delete profile ${chalk.cyan(args.name)}? This removes the profile config and cannot be undone.`,
      });
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    deleteProfile(args.name);
    console.log(`Profile ${chalk.cyan(args.name)} deleted.`);

    // The plugins volume is per profile; leave nothing behind (best effort —
    // `ccpod prune` also cleans unreferenced ones).
    const volName = pluginsVolumeName(args.name);
    try {
      if (await volumeExists(volName)) {
        await removeVolume(volName);
        console.log(chalk.dim(`Removed plugins volume ${volName}.`));
      }
    } catch {
      console.log(
        chalk.dim(
          `Could not remove plugins volume ${volName}; run 'ccpod prune'.`,
        ),
      );
    }
  },
});
