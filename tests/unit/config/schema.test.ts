import { describe, expect, it } from 'bun:test';
import {
  profileConfigSchema,
  projectConfigSchema,
} from '../../../src/config/schema.ts';

describe('profileConfigSchema', () => {
  it('parses minimal valid profile', () => {
    const result = profileConfigSchema.safeParse({
      config: { path: '/tmp/config', source: 'local' },
      name: 'test',
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults', () => {
    const result = profileConfigSchema.parse({
      config: { source: 'local' },
      name: 'test',
    });
    expect(result.state).toBe('ephemeral');
    expect(result.stateIsolation).toBe('per-profile');
    expect(result.ssh.agentForward).toBe(true);
    expect(result.network.policy).toBe('full');
    expect(result.ports.autoDetectMcp).toBe(true);
  });

  it('accepts stateIsolation: per-project', () => {
    const result = profileConfigSchema.parse({
      config: { source: 'local' },
      name: 'test',
      stateIsolation: 'per-project',
    });
    expect(result.stateIsolation).toBe('per-project');
  });

  it('rejects invalid stateIsolation value', () => {
    const result = profileConfigSchema.safeParse({
      config: { source: 'local' },
      name: 'test',
      stateIsolation: 'per-namespace',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown source', () => {
    const result = profileConfigSchema.safeParse({
      config: { source: 'ftp' },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('requires a repo when config source is git', () => {
    const result = profileConfigSchema.safeParse({
      config: { source: 'git' },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });
});

describe('serviceConfigSchema fields', () => {
  it('keeps dependency fields and defaults readiness timeout to 60 seconds', () => {
    const result = profileConfigSchema.parse({
      config: { source: 'local' },
      name: 'test',
      services: {
        api: { dependsOn: ['db'], image: 'api:latest', ready: {} },
        db: { image: 'db:latest' },
      },
    });
    expect(result.services.api.dependsOn).toEqual(['db']);
    expect(result.services.api.ready?.timeoutSeconds).toBe(60);
    expect(result.services.db.ready).toBeUndefined();
  });

  it('bounds readiness timeout to integer seconds from 1 through 3600', () => {
    for (const timeoutSeconds of [0, 3601, 1.5]) {
      expect(
        profileConfigSchema.safeParse({
          config: { source: 'local' },
          name: 'test',
          services: { db: { image: 'db', ready: { timeoutSeconds } } },
        }).success,
      ).toBe(false);
    }
    expect(
      profileConfigSchema.safeParse({
        config: { source: 'local' },
        name: 'test',
        services: { db: { image: 'db', ready: { timeoutSeconds: 3600 } } },
      }).success,
    ).toBe(true);
  });
});

describe('projectConfigSchema', () => {
  it('parses empty project config', () => {
    const result = projectConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('defaults merge to deep', () => {
    const result = projectConfigSchema.parse({});
    expect(result.merge).toBe('deep');
  });
});

describe('profileConfigSchema git ref/repo validation', () => {
  it('rejects ref starting with "-"', () => {
    const result = profileConfigSchema.safeParse({
      config: {
        ref: '--upload-pack=touch /tmp/pwn',
        repo: 'https://example.com/r.git',
        source: 'git',
      },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects ref containing ".."', () => {
    const result = profileConfigSchema.safeParse({
      config: {
        ref: '../etc',
        repo: 'https://example.com/r.git',
        source: 'git',
      },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects ref with shell metacharacters', () => {
    const result = profileConfigSchema.safeParse({
      config: {
        ref: 'main; rm -rf /',
        repo: 'https://example.com/r.git',
        source: 'git',
      },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects repo starting with "-"', () => {
    const result = profileConfigSchema.safeParse({
      config: {
        ref: 'main',
        repo: '-oProxyCommand=touch /tmp/pwn',
        source: 'git',
      },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects repo with unsupported scheme', () => {
    const result = profileConfigSchema.safeParse({
      config: {
        ref: 'main',
        repo: 'file:///etc/passwd',
        source: 'git',
      },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts https, ssh, git, and scp-style URLs', () => {
    for (const repo of [
      'https://github.com/foo/bar.git',
      'http://example.com/r.git',
      'ssh://git@example.com/foo.git',
      'git://example.com/foo.git',
      'git@github.com:foo/bar.git',
    ]) {
      const result = profileConfigSchema.safeParse({
        config: { ref: 'main', repo, source: 'git' },
        name: 'test',
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('profileConfigSchema auth.keyFile', () => {
  it('accepts ~/.ccpod/credentials/... paths', () => {
    const result = profileConfigSchema.safeParse({
      auth: {
        keyEnv: 'ANTHROPIC_API_KEY',
        keyFile: '~/.ccpod/credentials/default/api_key',
        type: 'api-key',
      },
      config: { source: 'local' },
      name: 'test',
    });
    expect(result.success).toBe(true);
  });

  it('rejects keyFile outside ~/.ccpod', () => {
    const result = profileConfigSchema.safeParse({
      auth: {
        keyEnv: 'ANTHROPIC_API_KEY',
        keyFile: '/etc/shadow',
        type: 'api-key',
      },
      config: { source: 'local' },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects keyFile with a directory whose name only shares the ~/.ccpod prefix', () => {
    const result = profileConfigSchema.safeParse({
      auth: {
        keyEnv: 'ANTHROPIC_API_KEY',
        keyFile: '~/.ccpod-evil/key',
        type: 'api-key',
      },
      config: { source: 'local' },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects keyFile containing ".."', () => {
    const result = profileConfigSchema.safeParse({
      auth: {
        keyEnv: 'ANTHROPIC_API_KEY',
        keyFile: '~/.ccpod/credentials/../../etc/passwd',
        type: 'api-key',
      },
      config: { source: 'local' },
      name: 'test',
    });
    expect(result.success).toBe(false);
  });
});
