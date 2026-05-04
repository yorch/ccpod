import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { profileConfigSchema } from '../../../config/schema.ts';
import {
  detectSource,
  fetchProfileYaml,
} from '../../../profile/installer.ts';
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
  meta: { description: 'Install a profile from a URL, git repo, file, or base64 string' },
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
        chalk.red(`Failed to fetch profile: ${err instanceof Error ? err.message : err}`),
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
      console.error(result.error.message);
      process.exit(1);
    }

    let profileName = result.data.name;

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
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'profile.yml'), finalYaml, 'utf8');

    console.log(chalk.green(`✓ Profile ${chalk.cyan(profileName)} installed.`));
    console.log(chalk.dim(`  Run: ccpod run ${profileName}`));
  },
});
