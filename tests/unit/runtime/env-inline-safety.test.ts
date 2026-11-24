import { describe, expect, it } from 'bun:test';
import { assertSafeInlineEnv } from '../../../src/runtime/env-file.ts';

describe('assertSafeInlineEnv', () => {
  const base = {
    FOO: 'host-foo',
    HOME: '/home/u',
    MULTI: 'a\nb',
    PATH: '/bin',
  };

  it('rejects CLI-sensitive keys carrying line breaks', () => {
    for (const key of [
      'HOME',
      'home',
      'PATH',
      'XDG_CONFIG_HOME',
      'SSH_ASKPASS',
      'GIT_SSH_COMMAND',
      'HTTPS_PROXY',
      'SSL_CERT_FILE',
      'CURL_CA_BUNDLE',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'DOCKER_CONFIG',
      'CCPOD_X',
      'GOFLAGS',
      'TMPDIR',
    ]) {
      expect(() => assertSafeInlineEnv(base, { [key]: 'x\n' })).toThrow(key);
    }
  });

  it('rejects overriding a different value already in the client env', () => {
    expect(() => assertSafeInlineEnv(base, { FOO: 'x\ny' })).toThrow('FOO');
  });

  it('allows a novel non-sensitive key', () => {
    expect(() =>
      assertSafeInlineEnv(base, { PEM_KEY: '-----BEGIN-----\nabc\n' }),
    ).not.toThrow();
  });

  it('allows re-forwarding the identical value of a host variable', () => {
    expect(() => assertSafeInlineEnv(base, { MULTI: 'a\nb' })).not.toThrow();
    expect(() => assertSafeInlineEnv(base, { HOME: '/home/u' })).not.toThrow();
  });
});
