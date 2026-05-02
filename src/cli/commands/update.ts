import chalk from 'chalk';
import { defineCommand } from 'citty';
import { GITHUB_BASE_URL } from '../../constants.ts';
import { isNewer } from '../../update/checker.ts';
import {
  downloadAndReplace,
  fetchLatestRelease,
  getAssetName,
} from '../../update/updater.ts';
import { VERSION } from '../../version.ts';

export default defineCommand({
  meta: { description: 'Update ccpod to the latest release' },
  async run() {
    const assetName = getAssetName();
    if (!assetName) {
      console.error(
        `${chalk.red('error:')} Unsupported platform (${process.platform}/${process.arch}). Download manually from ${GITHUB_BASE_URL}/releases`,
      );
      process.exit(1);
    }

    console.log(chalk.dim(`Current version: ${VERSION}`));
    process.stdout.write(chalk.dim('Checking for latest release...'));

    const latest = await fetchLatestRelease();
    process.stdout.write('\r\x1b[K');

    if (!latest) {
      console.error(
        `${chalk.red('error:')} No release asset found for ${assetName}`,
      );
      process.exit(1);
    }

    if (!isNewer(latest.version, VERSION)) {
      console.log(chalk.green(`✓ Already up to date (${VERSION})`));
      return;
    }

    console.log(`New version available: ${chalk.bold(latest.version)}`);
    process.stdout.write(chalk.dim(`Downloading ${latest.version}...`));

    try {
      await downloadAndReplace(latest.url, process.execPath);
    } catch (err) {
      process.stdout.write('\r\x1b[K');
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        console.error(
          `${chalk.red('error:')} Permission denied. Try: ${chalk.bold('sudo ccpod update')}`,
        );
        process.exit(1);
      }
      throw err;
    }

    process.stdout.write('\r\x1b[K');
    console.log(chalk.green(`✓ Updated to ${latest.version}`));
    console.log(chalk.dim(`  ${process.execPath}`));
  },
});
