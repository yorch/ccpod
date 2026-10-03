import chalk from 'chalk';
import { defineCommand } from 'citty';
import {
  listVolumeEntries,
  pluginsVolumeName,
  volumeExists,
} from '../../../plugins/volume.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { resolveProfileName } from '../../profile-arg.ts';

export default defineCommand({
  args: {
    json: { default: false, description: 'Output as JSON', type: 'boolean' },
    profile: {
      description: "Profile name (default: from .ccpod.yml or 'default')",
      type: 'string',
    },
  },
  meta: {
    description: "List plugins installed in a profile's volume",
    name: 'list',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    const profileName = resolveProfileName(args.profile);

    const volName = pluginsVolumeName(profileName);
    const exists = await volumeExists(volName);

    if (!exists) {
      if (args.json) {
        console.log(
          JSON.stringify({
            plugins: [],
            profile: profileName,
            volume: volName,
          }),
        );
        return;
      }
      console.log(
        `No plugins volume for profile '${profileName}'. Run 'ccpod run' to create it.`,
      );
      return;
    }

    if (!args.json) {
      console.log(chalk.dim(`Volume: ${volName}\n`));
    }

    let entries: string[];
    try {
      entries = await listVolumeEntries(volName, '/plugins');
    } catch (_e) {
      console.log(
        chalk.yellow(
          'Could not inspect volume (is Docker running with alpine image available?).',
        ),
      );
      console.log(
        chalk.dim(
          `Manual inspect: docker run --rm -v ${volName}:/p alpine ls /p`,
        ),
      );
      return;
    }

    const visible = entries.filter((e) => !e.startsWith('.'));
    if (args.json) {
      console.log(
        JSON.stringify({
          plugins: visible,
          profile: profileName,
          volume: volName,
        }),
      );
      return;
    }
    if (visible.length === 0) {
      console.log('No plugins installed yet.');
    } else {
      for (const entry of visible) {
        console.log(`  ${entry}`);
      }
      console.log(chalk.dim(`\n${visible.length} plugin(s)`));
    }
  },
});
