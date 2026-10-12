import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import {
  findProjectConfig,
  loadProfileConfig,
  loadProjectConfig,
} from '../../config/loader.ts';
import { getLastSync } from '../../profile/lock.ts';
import {
  getCcpodHome,
  getProfileDir,
  profileExists,
} from '../../profile/manager.ts';
import { detectRuntime } from '../../runtime/detector.ts';
import { dockerExec } from '../../runtime/docker.ts';
import { rejectExtraPositionals } from '../args.ts';
import { validateProfileArg } from '../validate.ts';

type Status = 'fail' | 'ok' | 'warn';
export interface DoctorCheck {
  detail: string;
  name: string;
  status: Status;
}
const ICON: Record<Status, string> = {
  fail: chalk.red('✗'),
  ok: chalk.green('✓'),
  warn: chalk.yellow('!'),
};
// Non-secret diagnostics, bounded so one bad stderr line cannot flood output.
const DETAIL_MAX = 160;
function firstLine(value: string): string {
  const line =
    value
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry !== '') ?? '';
  // Redact BEFORE truncating: cutting inside `user:password@` would leave the
  // credential prefix behind with no `@` left for the redactor to match.
  const redacted = redactLocation(line);
  return redacted.length > DETAIL_MAX
    ? `${redacted.slice(0, DETAIL_MAX)}…`
    : redacted;
}
function errorDetail(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error));
}
/**
 * Hide credentials that can be embedded in a remote daemon URL such as
 * `ssh://user:password@host`: doctor prints local paths, never secrets. The
 * match is greedy to the last `@` before the path, so multi-`@` userinfo and
 * percent-encoded credentials are removed too.
 */
function redactLocation(value: string): string {
  return value.replace(/\/\/[^\s/]*@/g, '//***@');
}
/** Passive checks avoid contacting Docker or reading credential contents. */
export function summarizeChecks(checks: DoctorCheck[]) {
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  return { checks, failed, warned };
}
export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
export async function collectChecks(
  profileArg: string | undefined,
  cwd: string,
  probe = false,
  runDocker: typeof dockerExec = dockerExec,
  findRuntime: typeof detectRuntime = detectRuntime,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: Status, detail: string) =>
    checks.push({ detail, name, status });
  let runtime: ReturnType<typeof detectRuntime> | undefined;
  try {
    runtime = findRuntime();
    // The socket/host tells the user which daemon ccpod would talk to; it is a
    // local path, not a credential.
    const location = runtime.dockerHost ?? runtime.socketPath;
    const shown = location ? redactLocation(location) : undefined;
    add(
      'container runtime',
      'ok',
      shown
        ? `${runtime.name} configured (${shown})`
        : `${runtime.name} configured`,
    );
  } catch {
    add('container runtime', 'warn', 'no container runtime detected');
  }
  if (probe) {
    if (!runtime) {
      add('Docker probe', 'fail', 'runtime could not be detected');
    } else {
      try {
        const { exitCode, stderr, stdout } = await runDocker(
          ['version', '--format', '{{.Server.Version}}'],
          undefined,
          { timeoutMs: 5000 },
        );
        add(
          'Docker probe',
          exitCode === 0 ? 'ok' : 'fail',
          exitCode === 0
            ? `daemon reachable (${stdout})`
            : stderr.trim() === ''
              ? 'daemon unavailable'
              : `daemon unavailable: ${redactLocation(firstLine(stderr))}`,
        );
      } catch (err) {
        add('Docker probe', 'fail', `Docker probe failed: ${errorDetail(err)}`);
      }
    }
  }

  let projectProfile: string | undefined;
  const projectPath = findProjectConfig(cwd);
  if (projectPath) {
    try {
      projectProfile = loadProjectConfig(cwd)?.profile;
      add('project config', 'ok', `valid (${projectPath})`);
    } catch (err) {
      add(
        'project config',
        'fail',
        `${projectPath} is invalid: ${errorDetail(err)}; run ccpod config validate`,
      );
    }
  } else {
    add('project config', 'ok', 'no .ccpod.yml (optional)');
  }

  const profileName = profileArg ?? projectProfile ?? 'default';
  if (!profileExists(profileName)) {
    add(
      'profile',
      'fail',
      `profile '${profileName}' not found (expected ${join(getCcpodHome(), 'profiles', profileName)})`,
    );
    return checks;
  }
  let profile: ReturnType<typeof loadProfileConfig>;
  try {
    const profileDir = getProfileDir(profileName);
    profile = loadProfileConfig(profileDir);
    add('profile', 'ok', `'${profileName}' (${profileDir})`);
  } catch (err) {
    add(
      'profile',
      'fail',
      `${getProfileDir(profileName)} is invalid: ${errorDetail(err)}; run ccpod config validate`,
    );
    return checks;
  }

  if (profile.auth.type === 'api-key') {
    const envPresent = Boolean(process.env[profile.auth.keyEnv]);
    const keyFilePath = profile.auth.keyFile?.replace(
      /^~\/\.ccpod/,
      getCcpodHome(),
    );
    const configuredFilePresent = keyFilePath ? existsSync(keyFilePath) : false;
    // Report which source was found (names and paths only, never values).
    const source = envPresent
      ? `env ${profile.auth.keyEnv}`
      : configuredFilePresent
        ? `file ${keyFilePath}`
        : undefined;
    add(
      'auth',
      source ? 'ok' : 'warn',
      source
        ? `credential source present: ${source} (contents not checked)`
        : `credential availability unknown; set ${profile.auth.keyEnv} or configure auth.keyFile`,
    );
  } else if (profile.auth.type === 'oauth') {
    const credentialFile = `${getCcpodHome()}/credentials/${profileName}/.credentials.json`;
    add(
      'auth',
      existsSync(credentialFile) ? 'ok' : 'warn',
      existsSync(credentialFile)
        ? 'credential file present (contents not checked)'
        : 'saved login not detected (contents not checked)',
    );
  } else {
    add(
      'auth',
      'warn',
      'host OAuth credential availability unknown (not inspected)',
    );
  }

  if (profile.image.dockerfile) {
    add('image', 'ok', 'configured for local build');
  } else {
    add(
      'image',
      'warn',
      'image availability unknown (use --probe to check Docker connectivity)',
    );
  }
  if (profile.config.source === 'git') {
    const last = getLastSync(getProfileDir(profileName));
    const age = last
      ? Math.floor((Date.now() - last.getTime()) / 86_400_000)
      : null;
    add(
      'config sync',
      age === null || age > 14 ? 'warn' : 'ok',
      last
        ? `last synced ${age === 0 ? 'today' : `${age} day(s) ago`}`
        : 'never synced',
    );
  }
  return checks;
}

export default defineCommand({
  args: {
    json: {
      default: false,
      description: 'Output checks as JSON',
      type: 'boolean',
    },
    probe: {
      default: false,
      description: 'Probe Docker daemon (read-only)',
      type: 'boolean',
    },
    profile: {
      description: 'Profile name (default: from .ccpod.yml or "default")',
      type: 'string',
    },
  },
  meta: {
    description: 'Passively check local configuration; --probe checks Docker',
    name: 'doctor',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    validateProfileArg(args.profile);
    const checks = await collectChecks(args.profile, process.cwd(), args.probe);
    const summary = summarizeChecks(checks);
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(chalk.bold('\nccpod doctor\n'));
      for (const c of checks) {
        console.log(
          `  ${ICON[c.status]} ${c.name.padEnd(18)} ${chalk.dim(c.detail)}`,
        );
      }
      console.log(
        `\n${summary.failed === 0 ? chalk.green('No problems found') : chalk.red(`${summary.failed} problem(s)`)}${summary.warned > 0 ? chalk.yellow(`, ${summary.warned} warning(s)`) : ''}.\n`,
      );
      console.log(
        chalk.yellow(
          'Doctor does not inspect credential contents. Container application secrets may appear in logs.',
        ),
      );
    }
    if (doctorExitCode(checks) !== 0) {
      process.exit(1);
    }
  },
});
