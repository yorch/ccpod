import chalk from 'chalk';
import { defineCommand } from 'citty';
import { exportProfile } from '../../../profile/exporter.ts';

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
    try {
      const encoded = exportProfile(args.name);
      process.stdout.write(`${encoded}\n`);
    } catch (err) {
      console.error(
        chalk.red(err instanceof Error ? err.message : String(err)),
      );
      process.exit(1);
    }
  },
});
