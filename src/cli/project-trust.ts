import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { z } from 'zod';
import { findProjectConfig } from '../config/loader.ts';
import { getCcpodHome } from '../profile/manager.ts';

// Project directory (realpath) -> profile names the user approved that
// project's .ccpod.yml to select. Lives in its own file (not config.yml) so it
// is never a user-settable key; only written after an interactive confirmation
// — a cloned repo cannot influence it.
const trustSchema = z.record(z.string(), z.array(z.string()));
type TrustStore = z.infer<typeof trustSchema>;

function trustPath(): string {
  return join(getCcpodHome(), 'trusted-projects.json');
}

function loadTrust(): TrustStore {
  const path = trustPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    return trustSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

function saveTrust(store: TrustStore): void {
  const path = trustPath();
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export type ConfirmFn = (message: string) => Promise<boolean>;

async function defaultConfirm(message: string): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ default: false, message });
}

function projectKey(cwd: string): string | null {
  const configPath = findProjectConfig(cwd);
  if (!configPath) {
    return null;
  }
  try {
    return realpathSync(dirname(configPath));
  } catch {
    return dirname(configPath);
  }
}

/**
 * A cloned repo's .ccpod.yml may name a profile (`profile: <name>`), which
 * would let untrusted content choose among the user's local profiles —
 * including permissive ones (allowProjectInit, host mounts, `network: full`).
 * Require explicit, remembered user approval the first time a project selects
 * a given profile. Passing `--profile` explicitly never reaches this check.
 */
export async function ensureProjectProfileTrusted(
  cwd: string,
  profileName: string,
  confirm: ConfirmFn = defaultConfirm,
  interactive: boolean = process.stdin.isTTY === true,
): Promise<void> {
  const key = projectKey(cwd);
  if (!key) {
    return;
  }
  const store = loadTrust();
  if (store[key]?.includes(profileName)) {
    return;
  }
  if (!interactive) {
    throw new Error(
      `${key}/.ccpod.yml selects profile '${profileName}', which you have not approved for this project. ` +
        `Pass --profile ${profileName} to use it explicitly, or run ccpod interactively once to approve it.`,
    );
  }
  console.log(
    chalk.yellow(
      `This project's .ccpod.yml selects profile '${profileName}'. A profile controls mounts, network policy and init behavior.`,
    ),
  );
  const ok = await confirm(
    `Allow ${key} to use profile '${profileName}'? (remembered)`,
  );
  if (!ok) {
    throw new Error(
      `Project profile '${profileName}' not approved. Use --profile to choose a profile explicitly.`,
    );
  }
  saveTrust({ ...store, [key]: [...(store[key] ?? []), profileName] });
}
