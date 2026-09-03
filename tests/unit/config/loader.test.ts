import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import {
  findProjectConfig,
  loadProfileConfig,
  loadProjectConfig,
} from '../../../src/config/loader.ts';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/ccpod-test-`);
});
afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

describe('loadProfileConfig', () => {
  it('parses a valid profile.yml', () => {
    writeFileSync(
      join(tmpDir, 'profile.yml'),
      yamlStringify({
        config: { path: '/tmp/cfg', source: 'local' },
        name: 'myprod',
      }),
    );
    const profile = loadProfileConfig(tmpDir);
    expect(profile.name).toBe('myprod');
    expect(profile.config.source).toBe('local');
    expect(profile.state).toBe('ephemeral'); // default applied
    expect(profile.ssh.agentForward).toBe(true); // default applied
  });

  it('throws when profile.yml is missing', () => {
    expect(() => loadProfileConfig(tmpDir)).toThrow(/Profile not found/);
  });
});

describe('findProjectConfig', () => {
  it('finds .ccpod.yml in the start directory', () => {
    writeFileSync(join(tmpDir, '.ccpod.yml'), 'merge: deep');
    expect(findProjectConfig(tmpDir)).toBe(
      join(realpathSync(tmpDir), '.ccpod.yml'),
    );
  });

  it('walks up to find .ccpod.yml in a parent directory', () => {
    const child = join(tmpDir, 'sub', 'deep');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(tmpDir, '.ccpod.yml'), 'merge: deep');
    expect(findProjectConfig(child)).toBe(
      join(realpathSync(tmpDir), '.ccpod.yml'),
    );
  });

  it('returns null when no .ccpod.yml found', () => {
    const child = join(tmpDir, 'sub');
    mkdirSync(child);
    expect(findProjectConfig(child)).toBeNull();
  });

  it('does not walk above the user home directory', () => {
    // The walk stops at $HOME — a .ccpod.yml in a subdirectory of $HOME is
    // found by a deeper child, but the walk never goes above $HOME.
    const os = require('node:os');
    const home = realpathSync(os.homedir());
    const testRoot = join(home, '.ccpod-test-loader-boundary');
    const child = join(testRoot, 'sub', 'deep');
    mkdirSync(child, { recursive: true });
    try {
      writeFileSync(join(testRoot, '.ccpod.yml'), 'merge: deep');
      expect(findProjectConfig(child)).toBe(join(testRoot, '.ccpod.yml'));
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  });
});

describe('loadProjectConfig', () => {
  it('returns null when no .ccpod.yml found', () => {
    expect(loadProjectConfig(tmpDir)).toBeNull();
  });

  it('parses a valid .ccpod.yml', () => {
    writeFileSync(
      join(tmpDir, '.ccpod.yml'),
      yamlStringify({ merge: 'override', profile: 'custom' }),
    );
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg).not.toBeNull();
    expect(cfg?.profile).toBe('custom');
    expect(cfg?.merge).toBe('override');
  });

  it('applies defaults for omitted fields', () => {
    writeFileSync(join(tmpDir, '.ccpod.yml'), '{}');
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg?.merge).toBe('deep');
  });

  it('rejects a symlink .ccpod.yml pointing outside the project', () => {
    const target = mkdtempSync(join(tmpdir(), 'ccpod-symlink-target-'));
    writeFileSync(join(target, 'secret.yml'), 'stolen: true');
    symlinkSync(join(target, 'secret.yml'), join(tmpDir, '.ccpod.yml'));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(loadProjectConfig(tmpDir)).toBeNull();
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => /symlink/i.test(w))).toBe(true);
    rmSync(target, { force: true, recursive: true });
  });
});
