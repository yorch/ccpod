import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadProfileConfig } from '../../../config/loader.ts';
import { ensureImage } from '../../../image/manager.ts';
import { getProfileDir } from '../../../profile/manager.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { resolveProfileName } from '../../profile-arg.ts';

export default defineCommand({
  args: {
    force: {
      default: false,
      description: 'Force re-pull even if image exists',
      type: 'boolean',
    },
    profile: { description: 'Profile name', type: 'string' },
  },
  meta: {
    description: 'Pull the Docker image for a profile',
    name: 'pull',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    const profileName = resolveProfileName(args.profile);

    const profile = loadProfileConfig(getProfileDir(profileName));
    const image = profile.image.use;

    if (image === 'build') {
      console.error(
        `Profile '${profileName}' uses a local build (image.use=build). Use 'ccpod image build' instead.`,
      );
      process.exit(1);
    }

    await ensureImage(image, args.force ?? false);
    console.log(chalk.green(`\n✓ Image ready: ${image}`));
  },
});
