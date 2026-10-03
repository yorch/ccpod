import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectProfileTrusted } from '../../../src/cli/project-trust.ts';

describe('ensureProjectProfileTrusted', () => {
  let home: string;
  let project: string;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    // Project must live under $HOME-bounded walk: point HOME at a temp dir so
    // findProjectConfig stops there, and CCPOD_TEST_DIR at a separate store.
    const root = mkdtempSync(join(tmpdir(), 'ccpod-trust-'));
    home = join(root, 'ccpod-home');
    project = join(root, 'proj');
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(join(project, '.ccpod.yml'), 'profile: work\n');
    process.env.CCPOD_TEST_DIR = home;
    process.env.HOME = root;
  });

  afterEach(() => {
    rmSync(join(home, '..'), { force: true, recursive: true });
    delete process.env.CCPOD_TEST_DIR;
    process.env.HOME = prevHome;
  });

  it('prompts once, remembers approval, and does not prompt again', async () => {
    const confirm = mock(async () => true);
    await ensureProjectProfileTrusted(project, 'work', confirm, true);
    await ensureProjectProfileTrusted(project, 'work', confirm, true);
    expect(confirm).toHaveBeenCalledTimes(1);
    const file = join(home, 'trusted-projects.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.values(JSON.parse(readFileSync(file, 'utf8')))[0]).toEqual([
      'work',
    ]);
  });

  it('rejects when the user declines, and remembers nothing', async () => {
    const confirm = mock(async () => false);
    await expect(
      ensureProjectProfileTrusted(project, 'work', confirm, true),
    ).rejects.toThrow(/not approved/);
    expect(existsSync(join(home, 'trusted-projects.json'))).toBe(false);
  });

  it('fails in non-interactive mode unless already trusted', async () => {
    const confirm = mock(async () => true);
    await expect(
      ensureProjectProfileTrusted(project, 'work', confirm, false),
    ).rejects.toThrow(/--profile work/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('approval for one profile does not cover another', async () => {
    const confirm = mock(async () => true);
    await ensureProjectProfileTrusted(project, 'work', confirm, true);
    await ensureProjectProfileTrusted(project, 'other', confirm, true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
