import chalk from 'chalk';
import { defineCommand } from 'citty';
import { exportProfile } from '../../../profile/exporter.ts';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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
    if (!NAME_RE.test(args.name)) {
      console.error(
        chalk.red(
          'Invalid profile name. Use only letters, digits, hyphens, and underscores (max 64 chars).',
        ),
      );
      process.exit(1);
    }
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
