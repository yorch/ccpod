import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAuth,
  resolveEnvForwarding,
} from '../../../src/auth/resolver.ts';

// Save env state around tests that mutate it
const savedEnv: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) {
    savedEnv[k] = process.env[k];
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  Object.keys(savedEnv).forEach((k) => {
    delete savedEnv[k];
  });
});

describe('resolveAuth', () => {
  it('oauth returns empty — tokens handled by entrypoint', () => {
    expect(resolveAuth({ type: 'oauth' })).toEqual({});
  });

  it('reads ANTHROPIC_API_KEY from env', () => {
    saveEnv('ANTHROPIC_API_KEY');
    process.env.ANTHROPIC_API_KEY = 'sk-test-abc';
    expect(
      resolveAuth({ keyEnv: 'ANTHROPIC_API_KEY', type: 'api-key' }),
    ).toEqual({
      ANTHROPIC_API_KEY: 'sk-test-abc',
    });
  });

  it('uses custom keyEnv name', () => {
    saveEnv('MY_ANTHROPIC_KEY');
    process.env.MY_ANTHROPIC_KEY = 'sk-custom-xyz';
    expect(
      resolveAuth({ keyEnv: 'MY_ANTHROPIC_KEY', type: 'api-key' }),
    ).toEqual({
      ANTHROPIC_API_KEY: 'sk-custom-xyz',
    });
  });

  it('reads key from file when env var absent', () => {
    saveEnv('ANTHROPIC_API_KEY');
    delete process.env.ANTHROPIC_API_KEY;

    const dir = mkdtempSync(`${tmpdir()}/ccpod-test-`);
    const keyFile = join(dir, 'api_key');
    writeFileSync(keyFile, 'sk-from-file\n');

    try {
      expect(
        resolveAuth({ keyEnv: 'ANTHROPIC_API_KEY', keyFile, type: 'api-key' }),
      ).toEqual({
        ANTHROPIC_API_KEY: 'sk-from-file',
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('returns empty when env absent and keyFile missing', () => {
    saveEnv('ANTHROPIC_API_KEY');
    delete process.env.ANTHROPIC_API_KEY;
    expect(
      resolveAuth({ keyEnv: 'ANTHROPIC_API_KEY', type: 'api-key' }),
    ).toEqual({});
  });
});

describe('resolveEnvForwarding', () => {
  it('forwards KEY from host env', () => {
    saveEnv('MY_VAR');
    process.env.MY_VAR = 'hello';
    expect(resolveEnvForwarding(['MY_VAR'], [], [])).toEqual({
      MY_VAR: 'hello',
    });
  });

  it('skips KEY not present in host env', () => {
    saveEnv('MISSING_VAR');
    delete process.env.MISSING_VAR;
    expect(resolveEnvForwarding(['MISSING_VAR'], [], [])).toEqual({});
  });

  it('uses inline KEY=VALUE without reading host env', () => {
    saveEnv('FORCE_VAR');
    delete process.env.FORCE_VAR;
    expect(resolveEnvForwarding(['FORCE_VAR=literal'], [], [])).toEqual({
      FORCE_VAR: 'literal',
    });
  });

  it('project keys override profile keys', () => {
    expect(resolveEnvForwarding(['X=profile'], ['X=project'], [])).toEqual({
      X: 'project',
    });
  });

  it('CLI overrides win over profile and project', () => {
    expect(
      resolveEnvForwarding(['X=profile'], ['X=project'], ['X=cli']),
    ).toEqual({ X: 'cli' });
  });

  it('handles value containing = sign', () => {
    expect(resolveEnvForwarding(['TOKEN=abc=def=ghi'], [], [])).toEqual({
      TOKEN: 'abc=def=ghi',
    });
  });

  it('merges keys from all three sources', () => {
    saveEnv('HOST_VAR');
    process.env.HOST_VAR = 'from-host';
    const result = resolveEnvForwarding(['HOST_VAR', 'A=1'], ['B=2'], ['C=3']);
    expect(result).toEqual({ A: '1', B: '2', C: '3', HOST_VAR: 'from-host' });
  });
});
