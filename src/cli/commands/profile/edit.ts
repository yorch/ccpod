import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { parse as parseYaml } from 'yaml';
import { profileConfigSchema } from '../../../config/schema.ts';
import { getProfileDir, profileExists } from '../../../profile/manager.ts';
import { exitWithError, formatCliError } from '../../errors.ts';
import { validateProfileArg } from '../../validate.ts';

export interface EditDeps {
  /** Re-open the editor after a validation failure? */
  askRetry: (problem: string) => Promise<boolean>;
  /** Open `file` in the user's editor; resolves when it exits. */
  openEditor: (file: string) => Promise<void>;
}

async function defaultOpenEditor(file: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  // $EDITOR may carry arguments ("code --wait").
  const proc = Bun.spawn([...editor.split(/\s+/).filter(Boolean), file], {
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Editor exited with status ${code}`);
  }
}

async function defaultAskRetry(problem: string): Promise<boolean> {
  console.error(chalk.red(`\nThe edited profile is invalid:\n${problem}\n`));
  const { confirm } = await import('@inquirer/prompts');
  return confirm({
    default: true,
    message: 'Edit again? (No discards your changes)',
  });
}

/**
 * Edit a profile's profile.yml in $EDITOR on a private copy; the real file is
 * only replaced once the result parses and passes schema validation, so a typo
 * can never leave a profile that `ccpod run` cannot load.
 * Returns true when the profile was changed.
 */
export async function editProfile(
  name: string,
  deps: EditDeps = {
    askRetry: defaultAskRetry,
    openEditor: defaultOpenEditor,
  },
): Promise<boolean> {
  validateProfileArg(name);
  if (!profileExists(name)) {
    throw new Error(`Profile '${name}' not found.`);
  }
  const target = join(getProfileDir(name), 'profile.yml');
  const original = readFileSync(target, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'ccpod-edit-'));
  const work = join(dir, 'profile.yml');
  try {
    copyFileSync(target, work);
    chmodSync(work, 0o600);
    while (true) {
      await deps.openEditor(work);
      const edited = readFileSync(work, 'utf8');
      if (edited === original) {
        return false;
      }
      let problem: string | null = null;
      try {
        const parsed = profileConfigSchema.parse(parseYaml(edited));
        if (parsed.name !== name) {
          problem = `  name: must stay '${name}' (it is the profile's directory name)`;
        }
      } catch (err) {
        problem = formatCliError(err);
      }
      if (problem === null) {
        writeFileSync(target, edited, { encoding: 'utf8', mode: 0o600 });
        chmodSync(target, 0o600);
        return true;
      }
      if (!(await deps.askRetry(problem))) {
        return false;
      }
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

export default defineCommand({
  args: {
    name: {
      description: 'Profile name',
      required: true,
      type: 'positional',
    },
  },
  meta: {
    description: 'Edit a profile in $EDITOR, validating before saving',
    name: 'edit',
  },
  async run({ args }) {
    if (!process.stdin.isTTY) {
      exitWithError(new Error('profile edit needs an interactive terminal.'));
    }
    try {
      const changed = await editProfile(args.name);
      console.log(
        changed
          ? chalk.green(`✓ Profile '${args.name}' updated.`)
          : chalk.dim('No changes saved.'),
      );
    } catch (err) {
      exitWithError(err);
    }
  },
});
