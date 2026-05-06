import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadProjectConfig } from '../../../config/loader.ts';
import {
  downloadOfficialDockerfile,
  OFFICIAL_DOCKERFILE_URL,
  OFFICIAL_ENTRYPOINT_URL,
} from '../../../image/downloader.ts';
import {
  getProfileDir,
  profileExists,
  updateProfileDockerfile,
} from '../../../profile/manager.ts';

export default defineCommand({
  args: {
    force: {
      default: false,
      description: 'Overwrite existing Dockerfile',
      type: 'boolean',
    },
    from: {
      description: `URL to download Dockerfile from (default: official ccpod Dockerfile)`,
      type: 'string',
    },
    profile: { description: 'Profile name', type: 'string' },
  },
  meta: {
    description:
      'Download a Dockerfile into the profile directory for local customization',
  },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? 'default';

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    const profileDir = getProfileDir(profileName);
    const destPath = join(profileDir, 'Dockerfile');

    if (existsSync(destPath) && !args.force) {
      console.error(
        `Dockerfile already exists at ${destPath}. Use --force to overwrite.`,
      );
      process.exit(1);
    }

    const url = args.from ?? OFFICIAL_DOCKERFILE_URL;

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        console.error(
          `Invalid URL scheme '${parsed.protocol}'. Only http/https are allowed.`,
        );
        process.exit(1);
      }
    } catch {
      console.error(`Invalid URL: ${url}`);
      process.exit(1);
    }

    if (args.from) {
      // Custom URL: only fetch the Dockerfile
      console.log(chalk.dim(`Downloading Dockerfile from ${url}...`));
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`Failed to download Dockerfile: HTTP ${res.status}`);
        process.exit(1);
      }
      writeFileSync(destPath, await res.text(), { mode: 0o644 });
    } else {
      // Official: use shared downloader (fetches Dockerfile + entrypoint.sh)
      console.log(chalk.dim(`Downloading Dockerfile from ${url}...`));
      console.log(
        chalk.dim(
          `Downloading entrypoint.sh from ${OFFICIAL_ENTRYPOINT_URL}...`,
        ),
      );
      try {
        await downloadOfficialDockerfile(profileDir);
      } catch (err) {
        console.error(String(err));
        process.exit(1);
      }
    }

    updateProfileDockerfile(profileName, '{{profile_dir}}/Dockerfile');

    console.log(chalk.green(`✓ Dockerfile saved to ${destPath}`));
    if (!args.from) {
      console.log(
        chalk.green(
          `✓ entrypoint.sh saved to ${join(profileDir, 'entrypoint.sh')}`,
        ),
      );
    }
    console.log(
      chalk.green(`✓ Profile '${profileName}' image.dockerfile updated`),
    );
    console.log(
      chalk.dim(`\nEdit ${destPath}, then run: ccpod image build --apply`),
    );
  },
});
