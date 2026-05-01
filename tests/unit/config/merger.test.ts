import { describe, expect, it } from 'bun:test';
import { mergeClaudes, mergeConfigs } from '../../../src/config/merger.ts';
import type { ProfileConfig } from '../../../src/types/index.ts';

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    auth: { keyEnv: 'ANTHROPIC_API_KEY', type: 'api-key' },
    claudeArgs: [],
    config: { path: '/tmp/cfg', source: 'local', sync: 'daily' },
    env: [],
    image: { use: 'ghcr.io/ccpod/base:latest' },
    name: 'base',
    network: { allow: [], policy: 'full' },
    plugins: [],
    ports: { autoDetectMcp: true, list: [] },
    services: {},
    ssh: { agentForward: true, mountSshDir: false },
    state: 'ephemeral',
    ...overrides,
  };
}

describe('mergeConfigs', () => {
  it('null project uses all profile defaults', () => {
    const result = mergeConfigs(makeProfile(), null);
    expect(result.profileName).toBe('base');
    expect(result.state).toBe('ephemeral');
    expect(result.network.policy).toBe('full');
    expect(result.autoDetectMcp).toBe(true);
  });

  it('state override takes precedence over profile', () => {
    const result = mergeConfigs(makeProfile({ state: 'persistent' }), null, {
      state: 'ephemeral',
    });
    expect(result.state).toBe('ephemeral');
  });

  it('deep merge: project network.allow appended to profile allow', () => {
    const profile = makeProfile({
      network: { allow: ['github.com'], policy: 'restricted' },
    });
    const result = mergeConfigs(profile, {
      merge: 'deep',
      network: { allow: ['npmjs.com'] },
    });
    expect(result.network.allow).toContain('github.com');
    expect(result.network.allow).toContain('npmjs.com');
  });

  it('override strategy: project network fully replaces profile network', () => {
    const profile = makeProfile({
      network: { allow: ['github.com'], policy: 'restricted' },
    });
    const result = mergeConfigs(profile, {
      merge: 'override',
      network: { policy: 'full' },
    });
    expect(result.network.policy).toBe('full');
    expect(result.network.allow).not.toContain('github.com');
  });

  it('port lists concatenate across profile and project', () => {
    const profile = makeProfile({
      ports: { autoDetectMcp: true, list: ['3000:3000'] },
    });
    const result = mergeConfigs(profile, { ports: { list: ['4000:4000'] } });
    expect(result.ports).toHaveLength(2);
    expect(result.ports[0]).toEqual({ container: 3000, host: 3000 });
    expect(result.ports[1]).toEqual({ container: 4000, host: 4000 });
  });

  it('project autoDetectMcp overrides profile', () => {
    const profile = makeProfile({ ports: { autoDetectMcp: true, list: [] } });
    const result = mergeConfigs(profile, { ports: { autoDetectMcp: false } });
    expect(result.autoDetectMcp).toBe(false);
  });

  it('env:{} — resolution deferred to run time (resolveEnvForwarding)', () => {
    // mergeConfigs intentionally returns env:{} — env forwarding keys are resolved
    // at run time by resolveEnvForwarding in run.ts, not at merge time.
    const profile = makeProfile({ env: ['FOO', 'BAR'] });
    const result = mergeConfigs(profile, { env: ['BAR', 'BAZ'] });
    expect(result.env).toEqual({});
  });

  it('parsePorts rejects malformed entries', () => {
    const profile = makeProfile({
      ports: { autoDetectMcp: false, list: [':3000'] },
    });
    expect(() => mergeConfigs(profile, null)).toThrow(
      'Invalid port mapping ":3000"',
    );
  });

  it('parsePorts rejects zero port values', () => {
    const profile = makeProfile({
      ports: { autoDetectMcp: false, list: ['0:3000'] },
    });
    expect(() => mergeConfigs(profile, null)).toThrow(
      'Invalid port mapping "0:3000"',
    );
  });

  it('deep merge: claudeArgs concatenates profile then project', () => {
    const profile = makeProfile({ claudeArgs: ['--verbose'] });
    const result = mergeConfigs(profile, {
      claudeArgs: ['--model', 'claude-opus-4-5'],
    });
    expect(result.claudeArgs).toEqual([
      '--verbose',
      '--model',
      'claude-opus-4-5',
    ]);
  });

  it('override strategy: project claudeArgs replaces profile', () => {
    const profile = makeProfile({ claudeArgs: ['--verbose'] });
    const result = mergeConfigs(profile, {
      claudeArgs: ['--dangerously-skip-permissions'],
      merge: 'override',
    });
    expect(result.claudeArgs).toEqual(['--dangerously-skip-permissions']);
  });

  it('override strategy with no project claudeArgs produces empty (clean slate)', () => {
    const profile = makeProfile({ claudeArgs: ['--verbose'] });
    const result = mergeConfigs(profile, { merge: 'override' });
    expect(result.claudeArgs).toEqual([]);
  });

  it('null project: claudeArgs comes from profile', () => {
    const profile = makeProfile({ claudeArgs: ['--verbose'] });
    const result = mergeConfigs(profile, null);
    expect(result.claudeArgs).toEqual(['--verbose']);
  });
});

describe('mergeClaudes', () => {
  it('appends project content below profile content', () => {
    const result = mergeClaudes('# Profile\nDo X', '# Project\nDo Y', 'append');
    expect(result).toContain('# Profile');
    expect(result).toContain('# Project');
    const profileIdx = result.indexOf('# Profile');
    const projectIdx = result.indexOf('# Project');
    expect(profileIdx).toBeLessThan(projectIdx);
  });

  it('overrides profile content with project content', () => {
    const result = mergeClaudes(
      '# Profile\nDo X',
      '# Project\nDo Y',
      'override',
    );
    expect(result).toBe('# Project\nDo Y');
    expect(result).not.toContain('# Profile');
  });
});
