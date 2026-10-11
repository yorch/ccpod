import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectChecks,
  doctorExitCode,
  summarizeChecks,
} from '../../../src/cli/commands/doctor.ts';

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccpod-doctor-'));
  mkdirSync(join(root, 'proj'));
  for (const k of ['HOME', 'ANTHROPIC_API_KEY', 'CCPOD_TEST_DIR']) {
    saved[k] = process.env[k];
  }
  process.env.HOME = root;
  process.env.CCPOD_TEST_DIR = join(root, '.ccpod');
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  rmSync(root, { force: true, recursive: true });
});

function writeProfile(name: string, yaml: string): void {
  const dir = join(root, '.ccpod', 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profile.yml'), yaml);
}

const find = (
  checks: Awaited<ReturnType<typeof collectChecks>>,
  name: string,
) => checks.find((c) => c.name.startsWith(name));

describe('doctor JSON and status summary', () => {
  it('has a stable secret-safe JSON shape and meaningful failure status', () => {
    const checks = [
      {
        detail: 'credential source present (contents not checked)',
        name: 'auth',
        status: 'warn' as const,
      },
      {
        detail: 'daemon unavailable',
        name: 'Docker probe',
        status: 'fail' as const,
      },
    ];
    expect(summarizeChecks(checks)).toEqual({ checks, failed: 1, warned: 1 });
    expect(doctorExitCode(checks)).toBe(1);
    expect(
      doctorExitCode(checks.filter((check) => check.status === 'warn')),
    ).toBe(0);
  });
});

describe('collectChecks', () => {
  it('fails with an actionable message when the profile does not exist', async () => {
    const checks = await collectChecks('nope', join(root, 'proj'));
    const profile = find(checks, 'profile');
    expect(profile?.status).toBe('fail');
    expect(profile?.detail).toContain("profile 'nope' not found");
  });

  it('reports a valid profile with a resolved API key', async () => {
    writeProfile(
      'work',
      'name: work\nconfig:\n  source: local\n  path: /tmp/cfg\n',
    );
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const checks = await collectChecks('work', join(root, 'proj'));
    expect(find(checks, 'profile')?.status).toBe('ok');
    expect(find(checks, 'auth')?.status).toBe('ok');
  });

  it('fails auth when no API key can be resolved', async () => {
    writeProfile(
      'work',
      'name: work\nconfig:\n  source: local\n  path: /tmp/cfg\n',
    );
    delete process.env.ANTHROPIC_API_KEY;
    const checks = await collectChecks('work', join(root, 'proj'));
    expect(find(checks, 'auth')?.status).toBe('warn');
  });

  it('does not invoke Docker or inspect credential contents by default', async () => {
    writeProfile(
      'work',
      `name: work\nconfig:\n  source: local\n  path: /tmp/cfg\nauth:\n  type: proxy\n`,
    );
    const docker = mock(async () => ({
      exitCode: 0,
      stderr: '',
      stdout: 'ok',
    }));
    const checks = await collectChecks(
      'work',
      join(root, 'proj'),
      false,
      docker as never,
    );
    expect(docker).not.toHaveBeenCalled();
    expect(find(checks, 'auth')?.status).toBe('warn');
    expect(find(checks, 'auth')?.detail).toContain('not inspected');
  });

  it('uses a bounded read-only Docker version probe only when requested', async () => {
    writeProfile(
      'work',
      `name: work\nconfig:\n  source: local\n  path: /tmp/cfg\n`,
    );
    const docker = mock(async () => ({
      exitCode: 0,
      stderr: '',
      stdout: '27.1',
    }));
    await collectChecks(
      'work',
      join(root, 'proj'),
      true,
      docker as never,
      () => ({ name: 'docker', socketPath: '/tmp/docker.sock' }),
    );
    expect(docker).toHaveBeenCalledTimes(1);
    expect(docker.mock.calls[0]?.[0]).toEqual([
      'version',
      '--format',
      '{{.Server.Version}}',
    ]);
    expect(docker.mock.calls[0]?.[1]).toBeUndefined();
    expect(docker.mock.calls[0]?.[2]).toEqual({ timeoutMs: 5000 });
  });

  it('reports an invalid profile.yml instead of throwing', async () => {
    writeProfile('bad', 'name: bad\n'); // config is required
    const checks = await collectChecks('bad', join(root, 'proj'));
    expect(find(checks, 'profile')?.status).toBe('fail');
  });
});
