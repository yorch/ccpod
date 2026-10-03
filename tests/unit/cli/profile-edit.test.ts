import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editProfile } from '../../../src/cli/commands/profile/edit.ts';

const VALID = 'name: work\nconfig:\n  source: local\n  path: /tmp/cfg\n';
let root: string;
let profileFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccpod-edit-test-'));
  process.env.CCPOD_TEST_DIR = root;
  const dir = join(root, 'profiles', 'work');
  mkdirSync(dir, { recursive: true });
  profileFile = join(dir, 'profile.yml');
  writeFileSync(profileFile, VALID);
});

afterEach(() => {
  delete process.env.CCPOD_TEST_DIR;
  rmSync(root, { force: true, recursive: true });
});

const noRetry = async () => false;

describe('editProfile', () => {
  it('saves a valid edit', async () => {
    const changed = await editProfile('work', {
      askRetry: noRetry,
      openEditor: async (file) => {
        writeFileSync(file, `${VALID}state: persistent\n`);
      },
    });
    expect(changed).toBe(true);
    expect(readFileSync(profileFile, 'utf8')).toContain('state: persistent');
  });

  it('does nothing when the file is unchanged', async () => {
    const changed = await editProfile('work', {
      askRetry: noRetry,
      openEditor: async () => {},
    });
    expect(changed).toBe(false);
  });

  it('never replaces the real file with an invalid edit', async () => {
    const changed = await editProfile('work', {
      askRetry: noRetry,
      openEditor: async (file) => {
        writeFileSync(file, 'name: work\n'); // missing required config
      },
    });
    expect(changed).toBe(false);
    expect(readFileSync(profileFile, 'utf8')).toBe(VALID);
  });

  it('re-opens the editor when asked to retry, then saves the fix', async () => {
    let opens = 0;
    const changed = await editProfile('work', {
      askRetry: async () => true,
      openEditor: async (file) => {
        opens++;
        writeFileSync(
          file,
          opens === 1 ? 'name: work\n' : `${VALID}state: persistent\n`,
        );
      },
    });
    expect(opens).toBe(2);
    expect(changed).toBe(true);
  });

  it('rejects renaming the profile inside the file', async () => {
    const changed = await editProfile('work', {
      askRetry: noRetry,
      openEditor: async (file) => {
        writeFileSync(file, VALID.replace('name: work', 'name: other'));
      },
    });
    expect(changed).toBe(false);
    expect(readFileSync(profileFile, 'utf8')).toBe(VALID);
  });

  it('errors for a missing profile', async () => {
    await expect(editProfile('ghost')).rejects.toThrow(/not found/);
  });
});
