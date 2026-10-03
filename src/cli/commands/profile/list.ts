import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadProfileConfig } from '../../../config/loader.ts';
import { getLastSync } from '../../../profile/lock.ts';
import { getProfileDir, listProfiles } from '../../../profile/manager.ts';

interface ProfileRow {
  description: string;
  image: string;
  imageDisplay: string;
  name: string;
  source: string;
  state: string;
  sync: string;
  valid: boolean;
}

function describeProfile(name: string): ProfileRow {
  const profileDir = getProfileDir(name);
  try {
    const cfg = loadProfileConfig(profileDir);
    const lastSync = getLastSync(profileDir);
    return {
      description: cfg.description ?? '',
      image: cfg.image.use,
      imageDisplay: cfg.image.use,
      name,
      source:
        cfg.config.source === 'git' ? `git (${cfg.config.sync})` : 'local',
      state: cfg.state,
      sync: lastSync ? lastSync.toLocaleDateString() : '-',
      valid: true,
    };
  } catch {
    return {
      description: '',
      image: '[invalid]',
      imageDisplay: chalk.red('[invalid]'),
      name,
      source: '-',
      state: '-',
      sync: '-',
      valid: false,
    };
  }
}

export default defineCommand({
  args: {
    json: { default: false, description: 'Output as JSON', type: 'boolean' },
  },
  meta: { description: 'List all profiles', name: 'list' },
  run({ args }) {
    const profiles = listProfiles();
    if (args.json) {
      // Always a JSON array (empty when there are no profiles) for scripting.
      console.log(
        JSON.stringify(
          profiles.map((n) => {
            const { imageDisplay: _display, ...row } = describeProfile(n);
            return row;
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (profiles.length === 0) {
      console.log('No profiles found. Run `ccpod init` to create one.');
      return;
    }

    const rows = profiles.map(describeProfile);

    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const imageW = Math.max(5, ...rows.map((r) => r.image.length));
    const sourceW = Math.max(6, ...rows.map((r) => r.source.length));
    const stateW = Math.max(5, ...rows.map((r) => r.state.length));
    const hasDescription = rows.some((r) => r.description.length > 0);

    const pad = (s: string, w: number) => s.padEnd(w);
    const padDisplay = (display: string, raw: string, w: number) =>
      display + ' '.repeat(w - raw.length);
    const truncate = (s: string, max: number) =>
      s.length > max ? `${s.slice(0, max - 1)}…` : s;

    const header = `${pad('NAME', nameW)}  ${pad('IMAGE', imageW)}  ${pad('SOURCE', sourceW)}  ${pad('STATE', stateW)}  LAST SYNC${hasDescription ? '  DESCRIPTION' : ''}`;
    console.log(chalk.dim(header));
    for (const r of rows) {
      const descCol = hasDescription
        ? `  ${chalk.dim(truncate(r.description, 60))}`
        : '';
      console.log(
        `${chalk.cyan(pad(r.name, nameW))}  ${padDisplay(r.imageDisplay, r.image, imageW)}  ${pad(r.source, sourceW)}  ${pad(r.state, stateW)}  ${r.sync}${descCol}`,
      );
    }
  },
});
