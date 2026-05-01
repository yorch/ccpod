import chalk from 'chalk';
import { defineCommand } from 'citty';
import type { GlobalConfig } from '../../../global/config.ts';
import { loadGlobalConfig } from '../../../global/config.ts';
import { KNOWN_KEYS } from './set.ts';

export default defineCommand({
  args: {
    key: {
      description: 'Config key to read',
      required: true,
      type: 'positional',
    },
  },
  meta: { description: 'Get a global ccpod config value' },
  run({ args }) {
    const key = args.key as string;

    if (!(key in KNOWN_KEYS)) {
      console.error(
        `${chalk.red('error:')} unknown config key '${key}'. Known keys: ${Object.keys(KNOWN_KEYS).join(', ')}`,
      );
      process.exit(1);
    }

    const config = loadGlobalConfig();
    console.log(String(config[key as keyof GlobalConfig]));
  },
});
