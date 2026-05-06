import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import {
  loadProfileConfig,
  loadProjectConfig,
} from '../../../config/loader.ts';
import { buildImage } from '../../../image/manager.ts';
import {
  expandProfilePath,
  getProfileDir,
  profileExists,
  updateProfileImage,
} from '../../../profile/manager.ts';

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
  meta: { description: 'Build a local Docker image for a profile' },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? 'default';

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    const profile = loadProfileConfig(getProfileDir(profileName));
    const rawDockerfile = args.dockerfile ?? profile.image.dockerfile;
    const dockerfile = rawDockerfile
      ? expandProfilePath(rawDockerfile, profileName)
      : rawDockerfile;

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

    const tag = args.tag ?? `ccpod-local-${profileName}:latest`;
    const contextDir = isAbsolute(dockerfile)
      ? dirname(dockerfile)
      : process.cwd();

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
