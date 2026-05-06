import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { stringify as yamlStringify } from 'yaml';
import {
  loadProfileConfig,
  loadProjectConfig,
} from '../../../config/loader.ts';
import { mergeClaudes, mergeConfigs } from '../../../config/merger.ts';
import {
  expandProfilePath,
  getProfileDir,
  profileExists,
} from '../../../profile/manager.ts';

export default defineCommand({
  args: {
    json: { default: false, description: 'Output as JSON', type: 'boolean' },
    profile: { description: 'Override profile name', type: 'string' },
  },
  meta: {
    description: 'Show effective merged config for the current directory',
  },
  run({ args }) {
    const cwd = process.cwd();
    const projectConfig = loadProjectConfig(cwd);
    const profileName = args.profile ?? projectConfig?.profile ?? 'default';

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found. Run 'ccpod init'.`);
      process.exit(1);
    }

    const profile = loadProfileConfig(getProfileDir(profileName));
    const merged = mergeConfigs(profile, projectConfig);

    // Display env forwarding keys (values are resolved at run time from the host env)
    const envKeys = [
      ...new Set([...profile.env, ...(projectConfig?.env ?? [])]),
    ];
    const envDisplay: Record<string, string> = {};
    for (const key of envKeys) {
      const eqIdx = key.indexOf('=');
      if (eqIdx !== -1) {
        const k = key.slice(0, eqIdx);
        const v = key.slice(eqIdx + 1);
        envDisplay[k] =
          k.toLowerCase().includes('key') || k.toLowerCase().includes('token')
            ? `${'*'.repeat(Math.min(v.length, 8))} (${v.length} chars)`
            : v;
      } else {
        envDisplay[key] = '<forwarded from host env>';
      }
    }

    const display = {
      auth: merged.auth,
      autoDetectMcp: merged.autoDetectMcp,
      env: envDisplay,
      image:
        merged.image === 'build'
          ? `build (${expandProfilePath(merged.dockerfile ?? 'Dockerfile', profileName)})`
          : merged.image,
      network: merged.network,
      ports: merged.ports,
      profile: merged.profileName,
      services: merged.services,
      ssh: merged.ssh,
      state: merged.state,
    };

    if (args.json) {
      console.log(JSON.stringify(display, null, 2));
      return;
    }

    console.log(chalk.bold(`\nMerged config — profile '${profileName}'\n`));
    console.log(yamlStringify(display));

    // Show CLAUDE.md preview
    const configSourceDir =
      profile.config.source === 'local'
        ? (profile.config.path ?? getProfileDir(profileName))
        : join(getProfileDir(profileName), 'config');

    const profileMd = readIfExists(join(configSourceDir, 'CLAUDE.md'));
    const projectMd = readIfExists(join(cwd, 'CLAUDE.md'));

    if (profileMd || projectMd) {
      const mode = projectConfig?.config?.claudeMd ?? 'append';
      const merged = mergeClaudes(profileMd ?? '', projectMd ?? '', mode);
      console.log(
        chalk.bold('CLAUDE.md') +
          chalk.dim(` (${mode} mode, ${merged.length} chars)`),
      );
      const preview = merged.split('\n').slice(0, 8).join('\n');
      console.log(chalk.dim(preview));
      if (merged.split('\n').length > 8) {
        console.log(chalk.dim('...'));
      }
      console.log();
    }
  },
});

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
