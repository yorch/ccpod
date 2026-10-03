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
  getProfileDir,
  resolveProfileDockerfile,
} from '../../../profile/manager.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { resolveProfileName } from '../../profile-arg.ts';

export default defineCommand({
  args: {
    json: { default: false, description: 'Output as JSON', type: 'boolean' },
    profile: { description: 'Override profile name', type: 'string' },
  },
  meta: {
    description: 'Show effective merged config for the current directory',
    name: 'show',
  },
  run({ args }) {
    rejectExtraPositionals(args);
    const cwd = process.cwd();
    const projectConfig = loadProjectConfig(cwd);
    const profileName = resolveProfileName(args.profile, cwd);

    const profile = loadProfileConfig(getProfileDir(profileName));
    const merged = mergeConfigs(profile, projectConfig);

    // Display env forwarding keys (values are resolved at run time from the
    // host env). Mirrors resolveEnvForwarding: isolation drops project env, and
    // a project's bare host-var names only forward when the profile allows them.
    const envDisplay: Record<string, string> = {};
    const addEnv = (entry: string, fromProject: boolean) => {
      const eqIdx = entry.indexOf('=');
      if (eqIdx !== -1) {
        const k = entry.slice(0, eqIdx);
        const v = entry.slice(eqIdx + 1);
        envDisplay[k] =
          k.toLowerCase().includes('key') || k.toLowerCase().includes('token')
            ? `${'*'.repeat(Math.min(v.length, 8))} (${v.length} chars)`
            : v;
      } else if (
        fromProject &&
        !profile.allowProjectEnvForward.includes(entry)
      ) {
        envDisplay[entry] = '<ignored: not in profile allowProjectEnvForward>';
      } else {
        envDisplay[entry] = '<forwarded from host env>';
      }
    };
    for (const entry of profile.env) {
      addEnv(entry, false);
    }
    for (const entry of profile.isolation ? [] : (projectConfig?.env ?? [])) {
      addEnv(entry, true);
    }

    const display = {
      allowProject: {
        envForward: profile.allowProjectEnvForward,
        hostMounts: profile.allowProjectHostMounts,
        init: profile.allowProjectInit,
        services: profile.allowProjectServices,
      },
      auth: merged.auth,
      autoDetectMcp: merged.autoDetectMcp,
      claudeArgs: merged.claudeArgs,
      env: envDisplay,
      image:
        merged.image === 'build'
          ? `build (${resolveProfileDockerfile(merged.dockerfile ?? 'Dockerfile', profileName)})`
          : merged.image,
      init: merged.init,
      isolation: profile.isolation,
      network: merged.network,
      permissions: profile.permissions ?? null,
      plugins: merged.plugins,
      ports: merged.ports,
      profile: merged.profileName,
      services: merged.services,
      ssh: merged.ssh,
      state: merged.state,
      stateIsolation: merged.stateIsolation,
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
    const projectMd = profile.isolation
      ? null
      : readIfExists(join(cwd, 'CLAUDE.md'));

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
