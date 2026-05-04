import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { parseDocument, parse as parseYaml } from 'yaml';
import { profileConfigSchema } from '../../../config/schema.ts';
import { detectSource, fetchProfileYaml } from '../../../profile/installer.ts';
import {
  ensureCcpodDirs,
  getProfileDir,
  profileExists,
} from '../../../profile/manager.ts';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export default defineCommand({
  args: {
    source: {
      description:
        'Profile source: git URL, raw HTTPS URL, file path, or base64 string',
      type: 'positional',
    },
  },
  meta: {
    description:
      'Install a profile from a URL, git repo, file, or base64 string',
  },
  async run({ args }) {
    if (!args.source) {
      console.error('Source required.');
      process.exit(1);
    }

    const source = detectSource(args.source);
    console.log(chalk.dim(`Fetching profile (${source.type})...`));

    let yaml: string;
    try {
      yaml = await fetchProfileYaml(source);
    } catch (err) {
      console.error(
        chalk.red(
          `Failed to fetch profile: ${err instanceof Error ? err.message : err}`,
        ),
      );
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(yaml);
    } catch {
      console.error(chalk.red('Invalid YAML in profile source.'));
      process.exit(1);
    }

    const result = profileConfigSchema.safeParse(parsed);
    if (!result.success) {
      console.error(chalk.red('Profile validation failed:'));
      for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        console.error(`  ${path}${issue.message}`);
      }
      process.exit(1);
    }

    let profileName = result.data.name;
    let overwriting = false;

    if (profileExists(profileName)) {
      const action = (await select({
        choices: [
          { name: 'Overwrite existing profile', value: 'overwrite' },
          { name: 'Install with a different name', value: 'rename' },
          { name: 'Cancel', value: 'cancel' },
        ],
        message: `Profile ${chalk.cyan(profileName)} already exists. What would you like to do?`,
      })) as 'cancel' | 'overwrite' | 'rename';

      if (action === 'cancel') {
        console.log('Aborted.');
        return;
      }

      if (action === 'overwrite') {
        overwriting = true;
      }

      if (action === 'rename') {
        profileName = await input({
          message: 'New profile name:',
          validate: (v: string) => {
            if (!NAME_RE.test(v)) {
              return 'Name may only contain letters, digits, hyphens, and underscores (max 64 chars)';
            }
            if (profileExists(v)) {
              return `Profile '${v}' already exists`;
            }
            return true;
          },
        });
      }
    }

    // If name changed, update the name field in YAML preserving other content
    let finalYaml = yaml;
    if (profileName !== result.data.name) {
      const doc = parseDocument(yaml);
      doc.set('name', profileName);
      finalYaml = doc.toString();
    }

    ensureCcpodDirs();
    const profileDir = getProfileDir(profileName);
    mkdirSync(profileDir, { mode: 0o700, recursive: true });

    if (overwriting) {
      // Clear stale config/ so git-sync doesn't keep pulling from the old remote
      rmSync(join(profileDir, 'config'), { force: true, recursive: true });
    }

    const profileYmlPath = join(profileDir, 'profile.yml');
    writeFileSync(profileYmlPath, finalYaml, { encoding: 'utf8', mode: 0o600 });
    // mode option only applies on file creation; chmod explicitly to handle overwrites
    chmodSync(profileYmlPath, 0o600);

    if (result.data.config?.source === 'local' && source.type === 'git') {
      console.warn(
        chalk.yellow(
          '  Warning: this profile uses a local config directory which was not copied from the git repo.',
        ),
      );
      console.warn(
        chalk.yellow(
          `  Manually populate ${join(profileDir, 'config')} or change the profile's config.source to "git".`,
        ),
      );
    }

    console.log(chalk.green(`✓ Profile ${chalk.cyan(profileName)} installed.`));
    console.log(chalk.dim(`  Run: ccpod run ${profileName}`));
  },
});
