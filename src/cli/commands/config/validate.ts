import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { parse as parseYaml } from 'yaml';
import { findProjectConfig } from '../../../config/loader.ts';
import {
  PROFILE_NAME_REGEX,
  profileConfigSchema,
  projectConfigSchema,
} from '../../../config/schema.ts';
import { getProfileDir } from '../../../profile/manager.ts';
import { rejectExtraPositionals } from '../../args.ts';
import { validateProfileArg } from '../../validate.ts';

export default defineCommand({
  args: {
    profile: { description: 'Profile name to validate', type: 'string' },
  },
  meta: {
    description: 'Validate profile and project config files',
    name: 'validate',
  },
  run({ args }) {
    rejectExtraPositionals(args);
    const cwd = process.cwd();
    validateProfileArg(args.profile);
    let allOk = true;
    let projectConfigPath: string | null = null;
    let projectConfig: ReturnType<typeof projectConfigSchema.parse> | undefined;
    let projectRaw: unknown;

    try {
      projectConfigPath = findProjectConfig(cwd);
      if (projectConfigPath) {
        projectRaw = parseYaml(readFileSync(projectConfigPath, 'utf8'));
        const result = projectConfigSchema.safeParse(projectRaw);
        if (result.success) {
          projectConfig = result.data;
          report(`.ccpod.yml (${projectConfigPath})`, true);
        } else {
          report(
            `.ccpod.yml (${projectConfigPath})`,
            false,
            result.error.message,
          );
          allOk = false;
        }
      }
    } catch (error) {
      report(
        `.ccpod.yml${projectConfigPath ? ` (${projectConfigPath})` : ''}`,
        false,
        errorMessage(error),
      );
      allOk = false;
    }
    if (!projectConfigPath) {
      console.log(chalk.dim('  .ccpod.yml  — not found (optional)'));
    }

    // Use only schema-validated project data for profile selection; never touch a
    // path derived from an invalid or unvalidated project profile string.
    let profileName = args.profile ?? projectConfig?.profile ?? 'default';
    if (!PROFILE_NAME_REGEX.test(profileName)) {
      report(
        'project profile selection',
        false,
        'Invalid profile name; refusing profile path access.',
      );
      allOk = false;
      profileName = 'default';
    }
    console.log(
      chalk.bold(`\nValidating config for profile '${profileName}'\n`),
    );

    const profileDir = getProfileDir(profileName);
    const profilePath = join(profileDir, 'profile.yml');
    let profileConfig: ReturnType<typeof profileConfigSchema.parse> | undefined;
    try {
      if (!existsSync(profilePath)) {
        throw new Error('File not found');
      }
      const raw = parseYaml(readFileSync(profilePath, 'utf8'));
      const result = profileConfigSchema.safeParse(raw);
      if (!result.success) {
        report(`profile.yml (${profilePath})`, false, result.error.message);
        allOk = false;
      } else {
        profileConfig = result.data;
        report(`profile.yml (${profilePath})`, true);
      }
    } catch (error) {
      report(`profile.yml (${profilePath})`, false, errorMessage(error));
      allOk = false;
    }

    if (profileConfig?.config.source === 'local' && profileConfig.config.path) {
      const sourcePath = profileConfig.config.path.replace(
        /^~(?=\/|$)/,
        homedir(),
      );
      if (existsSync(sourcePath)) {
        console.log(
          `${chalk.green('  ✓')}  config source path (${sourcePath})`,
        );
      } else {
        report(
          `config source path (${sourcePath})`,
          false,
          'Directory not found',
        );
        allOk = false;
      }
    } else if (
      profileConfig?.config.source === 'git' &&
      profileConfig.config.repo
    ) {
      console.log(
        chalk.dim(
          `  git repo    — ${profileConfig.config.repo} (not fetched; run 'ccpod profile update ${profileName}' to sync)`,
        ),
      );
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

function report(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? chalk.green('  ✓') : chalk.red('  ✗')}  ${label}`);
  if (detail) {
    console.log(chalk.dim(`       ${detail}`));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
