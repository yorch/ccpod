import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMergedConfig } from '../../../src/config/writer.ts';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup) {
    rmSync(dir, { force: true, recursive: true });
  }
  cleanup.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccpod-writer-test-'));
  cleanup.push(dir);
  return dir;
}

function run(
  profileDir: string,
  claudeMd: string,
  settings: object,
  projectDir?: string,
  initCommands?: string[],
): string {
  const out = writeMergedConfig(
    profileDir,
    claudeMd,
    settings,
    projectDir,
    initCommands,
  );
  cleanup.push(out);
  return out;
}

describe('writeMergedConfig', () => {
  it('writes CLAUDE.md with correct content', () => {
    const out = run(makeTempDir(), '# Hello\nWorld', {});
    expect(readFileSync(join(out, 'CLAUDE.md'), 'utf8')).toBe('# Hello\nWorld');
  });

  it('writes settings.json with correct content', () => {
    const out = run(makeTempDir(), '', { model: 'opus', theme: 'dark' });
    const settings = JSON.parse(
      readFileSync(join(out, 'settings.json'), 'utf8'),
    );
    expect(settings.theme).toBe('dark');
    expect(settings.model).toBe('opus');
  });

  it('returns same path for identical inputs (cache hit)', () => {
    const profileDir = makeTempDir();
    const first = run(profileDir, 'same content', { key: 'val' });
    const second = writeMergedConfig(profileDir, 'same content', {
      key: 'val',
    });
    expect(first).toBe(second);
  });

  it('returns different path when claudeMd changes', () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, 'content-a', {});
    const b = run(profileDir, 'content-b', {});
    expect(a).not.toBe(b);
  });

  it('returns different path when settings change', () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, 'same', { x: 1 });
    const b = run(profileDir, 'same', { x: 2 });
    expect(a).not.toBe(b);
  });

  it('copies regular files from profile config dir', () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, 'hooks.json'), '{"hooks":[]}');
    const out = run(profileDir, 'cp-test', { cp: true });
    expect(readFileSync(join(out, 'hooks.json'), 'utf8')).toBe('{"hooks":[]}');
  });

  it('skips symlinks from profile config dir', () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, 'real.txt'), 'real');
    symlinkSync(join(profileDir, 'real.txt'), join(profileDir, 'link.txt'));
    const out = run(profileDir, 'symlink-test', { sym: true });
    expect(existsSync(join(out, 'link.txt'))).toBe(false);
    expect(existsSync(join(out, 'real.txt'))).toBe(true);
  });

  it('generated CLAUDE.md overrides any CLAUDE.md in profile dir', () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, 'CLAUDE.md'), 'profile content');
    const out = run(profileDir, 'generated content', { override: true });
    expect(readFileSync(join(out, 'CLAUDE.md'), 'utf8')).toBe(
      'generated content',
    );
  });

  it('generated settings.json overrides any settings.json in profile dir', () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, 'settings.json'), '{"old":true}');
    const out = run(profileDir, '', { new: true });
    const settings = JSON.parse(
      readFileSync(join(out, 'settings.json'), 'utf8'),
    );
    expect(settings.new).toBe(true);
    expect(settings.old).toBeUndefined();
  });

  it('works when profileConfigDir does not exist', () => {
    const out = run('/nonexistent/path/abc123', 'no profile dir', {});
    expect(readFileSync(join(out, 'CLAUDE.md'), 'utf8')).toBe('no profile dir');
  });

  it('returns different path when a new file is added to profile dir', () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, 'stale-test', { v: 1 });
    // Add a new file to profileDir after first write
    writeFileSync(join(profileDir, 'new-hook.json'), '{"new":true}');
    const b = run(profileDir, 'stale-test', { v: 1 });
    expect(a).not.toBe(b);
    expect(existsSync(join(b, 'new-hook.json'))).toBe(true);
  });

  it('outputs CLAUDE.md and settings.json with restricted permissions', () => {
    const out = run(makeTempDir(), 'perm-test', { key: 'val' });
    const claudeMdMode = statSync(join(out, 'CLAUDE.md')).mode & 0o777;
    const settingsMode = statSync(join(out, 'settings.json')).mode & 0o777;
    expect(claudeMdMode).toBe(0o600);
    expect(settingsMode).toBe(0o600);
  });

  it('copies assets from project claude dir after profile (project wins on conflict)', () => {
    const profileDir = makeTempDir();
    const projectDir = makeTempDir();
    writeFileSync(join(profileDir, 'skill.js'), 'profile-version');
    writeFileSync(join(projectDir, 'skill.js'), 'project-version');
    const out = run(profileDir, '', {}, projectDir);
    expect(readFileSync(join(out, 'skill.js'), 'utf8')).toBe('project-version');
  });

  it('merges assets from both dirs — project adds files profile lacks', () => {
    const profileDir = makeTempDir();
    const projectDir = makeTempDir();
    writeFileSync(join(profileDir, 'profile-only.js'), 'p');
    writeFileSync(join(projectDir, 'project-only.js'), 'q');
    const out = run(profileDir, '', {}, projectDir);
    expect(existsSync(join(out, 'profile-only.js'))).toBe(true);
    expect(existsSync(join(out, 'project-only.js'))).toBe(true);
  });

  it('skips symlinks in project claude dir', () => {
    const profileDir = makeTempDir();
    const projectDir = makeTempDir();
    writeFileSync(join(projectDir, 'real.js'), 'real');
    symlinkSync(join(projectDir, 'real.js'), join(projectDir, 'link.js'));
    const out = run(profileDir, '', {}, projectDir);
    expect(existsSync(join(out, 'link.js'))).toBe(false);
    expect(existsSync(join(out, 'real.js'))).toBe(true);
  });

  it('cache invalidates when project dir contents change', () => {
    const profileDir = makeTempDir();
    const projectDir = makeTempDir();
    const a = run(profileDir, 'x', {}, projectDir);
    writeFileSync(join(projectDir, 'new-skill.js'), 'new');
    const b = run(profileDir, 'x', {}, projectDir);
    expect(a).not.toBe(b);
    expect(existsSync(join(b, 'new-skill.js'))).toBe(true);
  });

  it('works when project claude dir does not exist', () => {
    const out = run(
      makeTempDir(),
      'no-project',
      {},
      '/nonexistent/project/.claude',
    );
    expect(readFileSync(join(out, 'CLAUDE.md'), 'utf8')).toBe('no-project');
  });

  it('writes post-init.sh when init commands provided', () => {
    const out = run(makeTempDir(), '', {}, undefined, [
      'echo hello',
      'npm install',
    ]);
    const script = readFileSync(join(out, 'post-init.sh'), 'utf8');
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('set -e');
    expect(script).toContain('echo hello');
    expect(script).toContain('npm install');
  });

  it('post-init.sh has restricted permissions', () => {
    const out = run(makeTempDir(), '', {}, undefined, ['echo hi']);
    const mode = statSync(join(out, 'post-init.sh')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not write post-init.sh when init is empty', () => {
    const out = run(makeTempDir(), '', {});
    expect(existsSync(join(out, 'post-init.sh'))).toBe(false);
  });

  it('cache invalidates when init commands change', () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, 'x', {}, undefined, ['echo v1']);
    const b = run(profileDir, 'x', {}, undefined, ['echo v2']);
    expect(a).not.toBe(b);
    const scriptA = readFileSync(join(a, 'post-init.sh'), 'utf8');
    const scriptB = readFileSync(join(b, 'post-init.sh'), 'utf8');
    expect(scriptA).toContain('echo v1');
    expect(scriptB).toContain('echo v2');
  });

  it('cache hit when init commands are identical', () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, 'x', {}, undefined, ['echo same']);
    const b = run(profileDir, 'x', {}, undefined, ['echo same']);
    expect(a).toBe(b);
  });

  it('skips nested symlinks inside subdirectories', () => {
    const profileDir = makeTempDir();
    const skillsDir = join(profileDir, 'skills');
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, 'real.md'), 'skill');
    symlinkSync(join(skillsDir, 'real.md'), join(skillsDir, 'link.md'));
    const out = run(profileDir, '', {});
    expect(existsSync(join(out, 'skills', 'real.md'))).toBe(true);
    expect(existsSync(join(out, 'skills', 'link.md'))).toBe(false);
  });
});
