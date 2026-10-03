import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadProfileConfig } from '../../../config/loader.ts';
import { computeLocalImageTag } from '../../../image/hash.ts';
import { buildImage } from '../../../image/manager.ts';
import {
  expandProfilePath,
  getProfileDir,
  resolveProfileDockerfile,
  updateProfileImage,
} from '../../../profile/manager.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { resolveProfileName } from '../../profile-arg.ts';

export default defineCommand({
  args: {
    apply: {
      default: false,
      description: 'Update profile image.use to the built tag after build',
      type: 'boolean',
    },
    dockerfile: {
      description: 'Dockerfile path (overrides profile)',
      type: 'string',
    },
    profile: { description: 'Profile name', type: 'string' },
    tag: {
      description: 'Image tag (overrides auto-generated)',
      type: 'string',
    },
  },
  meta: {
    description: 'Build a local Docker image for a profile',
    name: 'build',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    const profileName = resolveProfileName(args.profile);

    const profile = loadProfileConfig(getProfileDir(profileName));
    // --dockerfile is user-typed (relative to cwd); a profile's own
    // image.dockerfile is anchored at the profile dir.
    const dockerfile = args.dockerfile
      ? expandProfilePath(args.dockerfile, profileName)
      : profile.image.dockerfile
        ? resolveProfileDockerfile(profile.image.dockerfile, profileName)
        : undefined;

    if (!dockerfile) {
      console.error(
        `${chalk.red('error:')} No Dockerfile configured for profile '${profileName}'.`,
      );
      console.error(
        chalk.dim(
          `  Run 'ccpod image init' to download the official Dockerfile, then customize it.`,
        ),
      );
      process.exit(1);
    }

    const contextDir = isAbsolute(dockerfile)
      ? dirname(dockerfile)
      : process.cwd();
    const tag =
      args.tag ?? computeLocalImageTag(profileName, dockerfile, contextDir);

    const resolvedDockerfile = isAbsolute(dockerfile)
      ? dockerfile
      : join(contextDir, dockerfile);
    if (!existsSync(resolvedDockerfile)) {
      console.error(
        `${chalk.red('error:')} Dockerfile not found: ${resolvedDockerfile}`,
      );
      process.exit(1);
    }

    console.log(chalk.dim(`Building ${dockerfile} → ${tag}`));
    await buildImage(dockerfile, tag, contextDir);
    console.log(chalk.green(`\n✓ Built: ${tag}`));

    if (args.apply) {
      updateProfileImage(profileName, tag);
      console.log(
        chalk.green(`✓ Profile '${profileName}' image.use updated to '${tag}'`),
      );
    } else {
      console.log(
        chalk.dim(
          `Run with --apply to update profile image.use automatically.`,
        ),
      );
    }
  },
});
