import chalk from 'chalk';
import { defineCommand } from 'citty';
import type { GlobalConfig } from '../../../global/config.ts';
import { loadGlobalConfig, saveGlobalConfig } from '../../../global/config.ts';

export const KNOWN_KEYS = {
  autoCheckUpdates: (v: string): boolean => {
    if (v === 'true' || v === '1') {
      return true;
    }
    if (v === 'false' || v === '0') {
      return false;
    }
    throw new Error('expected boolean (true/false)');
  },
} satisfies Record<keyof GlobalConfig, (v: string) => unknown>;

export default defineCommand({
  args: {
    key: {
      description: 'Config key to set',
      required: true,
      type: 'positional',
    },
    value: { description: 'Value to set', required: true, type: 'positional' },
  },
  meta: { description: 'Set a global ccpod config value' },
  run({ args }) {
    const key = args.key as string;
    const rawValue = args.value as string;

    if (!(key in KNOWN_KEYS)) {
      console.error(
        `${chalk.red('error:')} unknown config key '${key}'. Known keys: ${Object.keys(KNOWN_KEYS).join(', ')}`,
      );
      process.exit(1);
    }

    let coerced: unknown;
    try {
      coerced = KNOWN_KEYS[key as keyof GlobalConfig](rawValue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `${chalk.red('error:')} invalid value for '${key}': ${msg}`,
      );
      process.exit(1);
    }

    const config = loadGlobalConfig();
    saveGlobalConfig({ ...config, [key]: coerced });
    console.log(`${key} = ${coerced}`);
  },
});
