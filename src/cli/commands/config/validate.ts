import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { parse as parseYaml } from 'yaml';
import { findProjectConfig } from '../../../config/loader.ts';
import {
  profileConfigSchema,
  projectConfigSchema,
} from '../../../config/schema.ts';
import { getProfileDir, profileExists } from '../../../profile/manager.ts';

export default defineCommand({
  args: {
    profile: { description: 'Profile name to validate', type: 'string' },
  },
  meta: { description: 'Validate profile and project config files' },
  run({ args }) {
    const cwd = process.cwd();
    let allOk = true;

    // Determine profile to validate
    const projectConfigPath = findProjectConfig(cwd);
    let profileName = args.profile;

    if (!profileName && projectConfigPath) {
      try {
        const raw = parseYaml(readFileSync(projectConfigPath, 'utf8')) as {
          profile?: string;
        };
        profileName = raw.profile;
      } catch {
        // handled below
      }
    }
    profileName ??= 'default';

    console.log(
      chalk.bold(`\nValidating config for profile '${profileName}'\n`),
    );

    // --- Validate profile.yml ---
    const profileDir = getProfileDir(profileName);
    const profilePath = join(profileDir, 'profile.yml');
    allOk =
      check(`profile.yml (${profilePath})`, () => {
        if (!existsSync(profilePath)) {
          throw new Error('File not found');
        }
        const raw = parseYaml(readFileSync(profilePath, 'utf8'));
        profileConfigSchema.parse(raw);
      }) && allOk;

    // --- Validate .ccpod.yml (if present) ---
    if (projectConfigPath) {
      allOk =
        check(`.ccpod.yml (${projectConfigPath})`, () => {
          const raw = parseYaml(readFileSync(projectConfigPath, 'utf8'));
          projectConfigSchema.parse(raw);
        }) && allOk;
    } else {
      console.log(chalk.dim('  .ccpod.yml  — not found (optional)'));
    }

    // --- Validate config source path ---
    if (profileExists(profileName)) {
      const profileRaw = parseYaml(readFileSync(profilePath, 'utf8')) as {
        config?: { source?: string; path?: string; repo?: string };
      };
      const src = profileRaw.config;
      if (src?.source === 'local' && src.path) {
        allOk =
          check(`config source path (${src.path})`, () => {
            if (!existsSync(src.path ?? '')) {
              throw new Error('Directory not found');
            }
          }) && allOk;
      }
      if (src?.source === 'git' && src.repo) {
        console.log(
          chalk.dim(
            `  git repo    — ${src.repo} (not fetched; run 'ccpod profile update ${profileName}' to sync)`,
          ),
        );
      }
    }

    console.log();
    if (allOk) {
      console.log(chalk.green('✓ All checks passed.'));
    } else {
      console.log(chalk.red('✗ Some checks failed.'));
      process.exit(1);
    }
    console.log();
  },
});

function check(label: string, fn: () => void): boolean {
  try {
    fn();
    console.log(`${chalk.green('  ✓')}  ${label}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${chalk.red('  ✗')}  ${label}`);
    console.log(chalk.dim(`       ${msg}`));
    return false;
  }
}
