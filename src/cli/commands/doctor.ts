import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { readHostOAuthCredentials } from '../../auth/keychain.ts';
import { resolveAuth } from '../../auth/resolver.ts';
import {
  findProjectConfig,
  loadProfileConfig,
  loadProjectConfig,
} from '../../config/loader.ts';
import { getLastSync } from '../../profile/lock.ts';
import {
  getCredentialsDir,
  getProfileDir,
  profileExists,
} from '../../profile/manager.ts';
import { detectRuntime } from '../../runtime/detector.ts';
import { dockerExec } from '../../runtime/docker.ts';
import { rejectExtraPositionals } from '../args.ts';
import { validateProfileArg } from '../validate.ts';

type Status = 'fail' | 'ok' | 'warn';
interface Check {
  detail: string;
  name: string;
  status: Status;
}

const ICON: Record<Status, string> = {
  fail: chalk.red('✗'),
  ok: chalk.green('✓'),
  warn: chalk.yellow('!'),
};

function messageOf(err: unknown): string {
  return err instanceof Error
    ? (err.message.split('\n')[0] ?? '')
    : String(err);
}

/**
 * Collect environment checks for the current directory: container runtime,
 * profile and project config validity, auth, image availability, and config
 * sync freshness. Exported for testing.
 */
export async function collectChecks(
  profileArg: string | undefined,
  cwd: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) =>
    checks.push({ detail, name, status });

  // 1. Runtime + daemon
  try {
    const runtime = detectRuntime();
    const where = runtime.dockerHost ?? runtime.socketPath;
    const { exitCode, stderr, stdout } = await dockerExec([
      'version',
      '--format',
      '{{.Server.Version}}',
    ]);
    if (exitCode === 0) {
      add('container runtime', 'ok', `${runtime.name} ${stdout} (${where})`);
    } else {
      add(
        'container runtime',
        'fail',
        `${runtime.name} found at ${where} but the daemon is not reachable: ${stderr}`,
      );
    }
  } catch (err) {
    add('container runtime', 'fail', messageOf(err));
  }

  // 2. Project config
  let projectProfile: string | undefined;
  const projectPath = findProjectConfig(cwd);
  if (projectPath) {
    try {
      projectProfile = loadProjectConfig(cwd)?.profile;
      add('project config', 'ok', projectPath);
    } catch (err) {
      add('project config', 'fail', `${projectPath}: ${messageOf(err)}`);
    }
  } else {
    add('project config', 'ok', 'no .ccpod.yml (optional)');
  }

  // 3. Profile
  const profileName = profileArg ?? projectProfile ?? 'default';
  if (!profileExists(profileName)) {
    add(
      'profile',
      'fail',
      `'${profileName}' not found — run: ccpod init --profile ${profileName}`,
    );
    return checks;
  }
  let profile: ReturnType<typeof loadProfileConfig>;
  try {
    profile = loadProfileConfig(getProfileDir(profileName));
    add('profile', 'ok', `'${profileName}' (${getProfileDir(profileName)})`);
  } catch (err) {
    add('profile', 'fail', `'${profileName}': ${messageOf(err)}`);
    return checks;
  }

  // 4. Auth
  if (profile.auth.type === 'api-key') {
    const found = Object.keys(resolveAuth(profile.auth)).length > 0;
    add(
      'auth (api-key)',
      found ? 'ok' : 'fail',
      found
        ? 'API key resolved'
        : `set ${profile.auth.keyEnv} or configure auth.keyFile`,
    );
  } else if (profile.auth.type === 'oauth') {
    const cred = `${getCredentialsDir(profileName)}/.credentials.json`;
    add(
      'auth (oauth)',
      existsSync(cred) ? 'ok' : 'warn',
      existsSync(cred)
        ? 'credentials present'
        : "no saved login yet — 'ccpod run' will prompt you to sign in",
    );
  } else {
    const creds = readHostOAuthCredentials();
    add(
      'auth (proxy)',
      creds ? 'ok' : 'fail',
      creds
        ? 'host OAuth credentials found'
        : "no host OAuth credentials — run 'claude /login' on the host",
    );
  }

  // 5. Image
  if (profile.image.dockerfile) {
    add('image', 'ok', `built locally from ${profile.image.dockerfile}`);
  } else {
    const { exitCode } = await dockerExec([
      'image',
      'inspect',
      profile.image.use,
    ]).catch(() => ({ exitCode: 1 }));
    add(
      'image',
      exitCode === 0 ? 'ok' : 'warn',
      exitCode === 0
        ? `${profile.image.use} present`
        : `${profile.image.use} not pulled yet (pulled on first run)`,
    );
  }

  // 6. Git config sync
  if (profile.config.source === 'git') {
    const last = getLastSync(getProfileDir(profileName));
    const age = last
      ? Math.floor((Date.now() - last.getTime()) / 86_400_000)
      : null;
    add(
      'config sync',
      age === null || age > 14 ? 'warn' : 'ok',
      last
        ? `last synced ${age === 0 ? 'today' : `${age} day(s) ago`} (${profile.config.sync ?? 'daily'})`
        : 'never synced',
    );
  }

  return checks;
}

export default defineCommand({
  args: {
    profile: {
      description: 'Profile name (default: from .ccpod.yml or "default")',
      type: 'string',
    },
  },
  meta: {
    description: 'Check the environment: runtime, config, auth, and image',
    name: 'doctor',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    validateProfileArg(args.profile);
    const checks = await collectChecks(args.profile, process.cwd());
    console.log(chalk.bold('\nccpod doctor\n'));
    for (const c of checks) {
      console.log(
        `  ${ICON[c.status]} ${c.name.padEnd(18)} ${chalk.dim(c.detail)}`,
      );
    }
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    console.log(
      `\n${failed === 0 ? chalk.green('No problems found') : chalk.red(`${failed} problem(s)`)}${warned > 0 ? chalk.yellow(`, ${warned} warning(s)`) : ''}.\n`,
    );
    if (failed > 0) {
      process.exit(1);
    }
  },
});
