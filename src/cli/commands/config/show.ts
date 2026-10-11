import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { stringify as yamlStringify } from 'yaml';
import { explainProjectEnvEntry } from '../../../auth/resolver.ts';
import {
  explainConfig,
  redactLiteral,
  redactServiceEnv,
} from '../../../config/explain.ts';
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
    explain: {
      default: false,
      description: 'Include effective sources and ignored project inputs',
      type: 'boolean',
    },
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
      const key = (eqIdx === -1 ? entry : entry.slice(0, eqIdx)).trim();
      if (fromProject) {
        const decision = explainProjectEnvEntry(
          entry,
          profile.allowProjectEnvForward,
        );
        if (!decision.eligible) {
          if (decision.disposition === 'rejected') {
            // Preserve legacy plain output, but --explain reports the shared
            // runtime-blocking error below instead of presenting success.
            if (!args.explain && envDisplay[key] === undefined) {
              envDisplay[key] = redactLiteral(entry.slice(eqIdx + 1));
            }
          } else if (envDisplay[key] === undefined) {
            envDisplay[key] = `<ignored: ${decision.reason}>`;
          }
          return;
        }
      }
      if (eqIdx !== -1) {
        envDisplay[key] = redactLiteral(entry.slice(eqIdx + 1));
      } else {
        envDisplay[key] = '<forwarded from host env>';
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
      services: redactServiceEnv(merged.services),
      ssh: merged.ssh,
      state: merged.state,
      stateIsolation: merged.stateIsolation,
    };

    const explanation = args.explain
      ? explainConfig(profile, projectConfig)
      : undefined;
    if (explanation?.errors.length) {
      const details = explanation.errors
        .map(
          (error) =>
            `  ${error.path.replace(/[^\x20-\x7e]/g, '?')}: ${error.reason} (runtime setup rejects this entry)`,
        )
        .join('\n');
      console.error(
        `${chalk.red('error:')} Project config contains runtime-rejected entries:\n${details}`,
      );
      process.exit(1);
      return;
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          explanation ? { ...display, explain: explanation } : display,
          null,
          2,
        ),
      );
      return;
    }
    if (args.explain) {
      console.log(chalk.bold(`\nMerged config — profile '${profileName}'\n`));
      console.log(yamlStringify({ ...display, explain: explanation }));
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
