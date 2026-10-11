import { existsSync } from 'node:fs';
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
    add('container runtime', 'ok', `${runtime.name} configured`);
  } catch {
    add('container runtime', 'warn', 'no container runtime detected');
  }
  if (probe) {
    if (!runtime) {
      add('Docker probe', 'fail', 'runtime could not be detected');
    } else {
      try {
        const { exitCode, stdout } = await runDocker(
          ['version', '--format', '{{.Server.Version}}'],
          undefined,
          { timeoutMs: 5000 },
        );
        add(
          'Docker probe',
          exitCode === 0 ? 'ok' : 'fail',
          exitCode === 0
            ? `daemon reachable (${stdout})`
            : 'daemon unavailable',
        );
      } catch {
        add('Docker probe', 'fail', 'Docker probe failed');
      }
    }
  }

  let projectProfile: string | undefined;
  const projectPath = findProjectConfig(cwd);
  if (projectPath) {
    try {
      projectProfile = loadProjectConfig(cwd)?.profile;
      add('project config', 'ok', 'valid');
    } catch {
      add(
        'project config',
        'fail',
        'configuration is invalid; run ccpod config validate',
      );
    }
  } else {
    add('project config', 'ok', 'no .ccpod.yml (optional)');
  }

  const profileName = profileArg ?? projectProfile ?? 'default';
  if (!profileExists(profileName)) {
    add('profile', 'fail', `profile '${profileName}' not found`);
    return checks;
  }
  let profile: ReturnType<typeof loadProfileConfig>;
  try {
    profile = loadProfileConfig(getProfileDir(profileName));
    add('profile', 'ok', `'${profileName}'`);
  } catch {
    add(
      'profile',
      'fail',
      'profile configuration is invalid; run ccpod config validate',
    );
    return checks;
  }

  if (profile.auth.type === 'api-key') {
    const envPresent = Boolean(process.env[profile.auth.keyEnv]);
    const configuredFilePresent = profile.auth.keyFile
      ? existsSync(profile.auth.keyFile.replace(/^~\/\.ccpod/, getCcpodHome()))
      : false;
    const present = envPresent || configuredFilePresent;
    add(
      'auth',
      present ? 'ok' : 'warn',
      present
        ? 'credential source present (contents not checked)'
        : 'credential availability unknown; configure the key source',
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
