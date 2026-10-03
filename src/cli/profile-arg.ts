import { loadProjectConfig } from '../config/loader.ts';
import { profileExists } from '../profile/manager.ts';
import { exitWithError } from './errors.ts';
import { validateProfileArg } from './validate.ts';

/**
 * Profile for commands that act on one: `--profile`, else the project's
 * `.ccpod.yml` choice, else `default`. Validates the name and exits with a
 * clear error when the profile does not exist.
 */
export function resolveProfileName(
  profileArg: string | undefined,
  cwd: string = process.cwd(),
): string {
  validateProfileArg(profileArg);
  const name = profileArg ?? loadProjectConfig(cwd)?.profile ?? 'default';
  if (!profileExists(name)) {
    exitWithError(
      new Error(
        `Profile '${name}' not found. Run 'ccpod init --profile ${name}'.`,
      ),
    );
  }
  return name;
}
