import chalk from 'chalk';
import { defineCommand } from 'citty';
import { exportProfile } from '../../../profile/exporter.ts';
import { validateProfileArg } from '../../validate.ts';

export default defineCommand({
  args: {
    name: { description: 'Profile name', type: 'positional' },
  },
  meta: { description: 'Export a profile as a shareable base64 string' },
  run({ args }) {
    if (!args.name) {
      console.error('Profile name required.');
      process.exit(1);
    }
    validateProfileArg(args.name);
    try {
      const encoded = exportProfile(args.name);
      console.warn(
        chalk.yellow(
          'Warning: the exported string contains your full profile configuration.',
        ),
      );
      console.warn(
        chalk.yellow(
          'Do not share it publicly if your profile contains sensitive data.',
        ),
      );
      process.stdout.write(`${encoded}\n`);
    } catch (err) {
      console.error(
        chalk.red(err instanceof Error ? err.message : String(err)),
      );
      process.exit(1);
    }
  },
});
