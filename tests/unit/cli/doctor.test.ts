import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectChecks } from '../../../src/cli/commands/doctor.ts';

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

describe('collectChecks', () => {
  it('fails with an actionable message when the profile does not exist', async () => {
    const checks = await collectChecks('nope', join(root, 'proj'));
    const profile = find(checks, 'profile');
    expect(profile?.status).toBe('fail');
    expect(profile?.detail).toContain('ccpod init --profile nope');
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
    expect(find(checks, 'auth')?.status).toBe('fail');
  });

  it('reports an invalid profile.yml instead of throwing', async () => {
    writeProfile('bad', 'name: bad\n'); // config is required
    const checks = await collectChecks('bad', join(root, 'proj'));
    expect(find(checks, 'profile')?.status).toBe('fail');
  });
});
