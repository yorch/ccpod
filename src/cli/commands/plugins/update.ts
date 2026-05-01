import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadProjectConfig } from '../../../config/loader.ts';
import {
  pluginsVolumeName,
  removeVolume,
  volumeExists,
} from '../../../plugins/volume.ts';
import { profileExists } from '../../../profile/manager.ts';

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
  },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? 'default';

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    const volName = pluginsVolumeName(profileName);

    if (!args.reset) {
      console.log(
        `Use --reset to remove the plugins volume for '${profileName}'.`,
      );
      console.log(chalk.dim(`Volume: ${volName}`));
      console.log(
        chalk.dim(
          '\nTo install specific plugins on next run, set CCPOD_PLUGINS_TO_INSTALL=plugin1,plugin2 in your profile env.',
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
