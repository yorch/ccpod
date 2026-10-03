import chalk from 'chalk';
import { defineCommand } from 'citty';
import {
  pluginsVolumeName,
  removeVolume,
  volumeExists,
} from '../../../plugins/volume.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { resolveProfileName } from '../../profile-arg.ts';

export default defineCommand({
  args: {
    profile: { description: 'Profile name', type: 'string' },
    reset: {
      default: false,
      description: 'Remove the volume entirely',
      type: 'boolean',
    },
  },
  meta: {
    description: 'Reset the plugins volume (forces reinstall on next run)',
    name: 'update',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    const profileName = resolveProfileName(args.profile);

    const volName = pluginsVolumeName(profileName);

    if (!args.reset) {
      console.log(
        `Use --reset to remove the plugins volume for '${profileName}'.`,
      );
      console.log(chalk.dim(`Volume: ${volName}`));
      console.log(
        chalk.dim(
          '\nTo install specific plugins on next run, list them under `plugins:` in the profile.',
        ),
      );
      return;
    }

    const exists = await volumeExists(volName);
    if (!exists) {
      console.log(`No plugins volume found for '${profileName}'.`);
      return;
    }

    process.stdout.write(`Removing ${chalk.cyan(volName)}... `);
    await removeVolume(volName);
    console.log(chalk.green('done'));
    console.log(chalk.dim("Plugins will be reinstalled on next 'ccpod run'."));
  },
});
