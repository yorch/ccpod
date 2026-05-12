// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${VAR} literals are the system under test
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
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

  describe('host variable interpolation', () => {
    it('expands ${VAR} from host env in value', () => {
      saveEnv('GH_TOKEN');
      process.env.GH_TOKEN = 'ghp_abc';
      expect(resolveEnvForwarding(['MY_TOKEN=${GH_TOKEN}'], [], [])).toEqual({
        MY_TOKEN: 'ghp_abc',
      });
    });

    it('expands ${VAR:-default} when unset', () => {
      saveEnv('NOT_SET');
      delete process.env.NOT_SET;
      expect(resolveEnvForwarding(['MY=${NOT_SET:-fallback}'], [], [])).toEqual(
        { MY: 'fallback' },
      );
    });

    it('prefers host value over default when set', () => {
      saveEnv('PRESENT');
      process.env.PRESENT = 'real';
      expect(resolveEnvForwarding(['MY=${PRESENT:-fallback}'], [], [])).toEqual(
        { MY: 'real' },
      );
    });

    it('substitutes empty for unset var without default', () => {
      saveEnv('NOPE');
      delete process.env.NOPE;
      expect(resolveEnvForwarding(['MY=${NOPE}'], [], [])).toEqual({
        MY: '',
      });
    });

    it('handles mixed literal text and interpolation', () => {
      saveEnv('USER_NAME');
      process.env.USER_NAME = 'alice';
      expect(
        resolveEnvForwarding(['GREETING=hello ${USER_NAME}!'], [], []),
      ).toEqual({ GREETING: 'hello alice!' });
    });

    it('expands multiple vars in one value', () => {
      saveEnv('A', 'B');
      process.env.A = 'x';
      process.env.B = 'y';
      expect(resolveEnvForwarding(['COMBO=${A}-${B}'], [], [])).toEqual({
        COMBO: 'x-y',
      });
    });

    it('empty default works', () => {
      saveEnv('EMPTY_DEFAULT');
      delete process.env.EMPTY_DEFAULT;
      expect(resolveEnvForwarding(['MY=${EMPTY_DEFAULT:-}'], [], [])).toEqual({
        MY: '',
      });
    });

    it('does NOT interpolate bare key form (treated as host var name)', () => {
      saveEnv('LITERAL');
      delete process.env.LITERAL;
      // Bare "${LITERAL}" is not a valid env var name, so process.env lookup
      // fails and the entry is skipped (existing behavior).
      expect(resolveEnvForwarding(['${LITERAL}'], [], [])).toEqual({});
    });

    it('leaves unmatched dollar text alone', () => {
      expect(resolveEnvForwarding(['PRICE=$100 plain'], [], [])).toEqual({
        PRICE: '$100 plain',
      });
    });

    it('interpolation works in CLI overrides', () => {
      saveEnv('TOK');
      process.env.TOK = 'cli-tok';
      expect(resolveEnvForwarding([], [], ['MY=${TOK}'])).toEqual({
        MY: 'cli-tok',
      });
    });

    it('treats host var set to empty string as set (POSIX :- semantics)', () => {
      saveEnv('EMPTY_SET');
      process.env.EMPTY_SET = '';
      expect(
        resolveEnvForwarding(['MY=${EMPTY_SET:-fallback}'], [], []),
      ).toEqual({ MY: '' });
    });

    it('warns at most once per missing var across profile and CLI', () => {
      saveEnv('NOPE_DEDUP');
      delete process.env.NOPE_DEDUP;
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        resolveEnvForwarding(
          ['A=${NOPE_DEDUP}', 'B=${NOPE_DEDUP}'],
          [],
          ['D=${NOPE_DEDUP}'],
        );
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects ${VAR} interpolation in project env entries', () => {
      saveEnv('AWS_SECRET_ACCESS_KEY');
      process.env.AWS_SECRET_ACCESS_KEY = 'shhh';
      expect(() =>
        resolveEnvForwarding([], ['LEAK=${AWS_SECRET_ACCESS_KEY}'], []),
      ).toThrow(/project env/);
    });

    it('allows literal values in project env entries', () => {
      expect(resolveEnvForwarding([], ['DEBUG=1'], [])).toEqual({
        DEBUG: '1',
      });
    });

    it('allows bare host-var forwarding in project env entries', () => {
      saveEnv('PROJECT_HOST_VAR');
      process.env.PROJECT_HOST_VAR = 'forwarded';
      expect(resolveEnvForwarding([], ['PROJECT_HOST_VAR'], [])).toEqual({
        PROJECT_HOST_VAR: 'forwarded',
      });
    });

    it('does not warn when default is supplied for unset var', () => {
      saveEnv('UNSET_WITH_DEFAULT');
      delete process.env.UNSET_WITH_DEFAULT;
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        resolveEnvForwarding(['A=${UNSET_WITH_DEFAULT:-x}'], [], []);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
