import { describe, expect, it } from 'bun:test';
import { explainProjectEnvEntry } from '../../../src/auth/resolver.ts';
import {
  explainConfig,
  redactLiteral,
  redactServiceEnv,
} from '../../../src/config/explain.ts';
import type { ProfileConfig, ProjectConfig } from '../../../src/types/index.ts';

const profile = {
  allowProjectEnvForward: ['SAFE_FORWARD'],
  allowProjectHostMounts: false,
  allowProjectInit: false,
  allowProjectServices: false,
  config: { source: 'local' as const },
  env: [],
  image: { use: 'image' },
  isolation: false,
  name: 'default',
  ports: { autoDetectMcp: true, list: [] },
  services: {},
} as ProfileConfig;

const project = {
  env: [
    'PUBLIC=value',
    'SAFE_FORWARD',
    'NO_FORWARD',
    'PATH=host',
    `TOKEN=\${HOST_SECRET}`,
  ],
  init: ['echo hi'],
  network: { policy: 'full' },
  services: { db: { env: { PASSWORD: 'service-secret' }, image: 'db' } },
} as ProjectConfig;

describe('config explain', () => {
  it('reports effective source and ignored reasons without resolving host values', () => {
    expect(explainConfig(profile, project)).toEqual({
      errors: [
        {
          path: 'project.env[4] (TOKEN)',
          reason: 'project env interpolation is not allowed',
        },
      ],
      ignored: [
        { path: 'project.network', reason: 'network policy is profile-owned' },
        { path: 'project.init', reason: 'profile allowProjectInit is false' },
        {
          path: 'project.services',
          reason: 'profile allowProjectServices is false',
        },
        {
          path: 'project.env[2] (NO_FORWARD)',
          reason:
            'host forwarding is not allowed by profile allowProjectEnvForward',
        },
        { path: 'project.env[3] (PATH)', reason: 'blocked project env key' },
      ],
      sources: {
        allowProject: 'profile',
        auth: 'profile',
        autoDetectMcp: 'profile',
        claudeArgs: 'profile',
        env: 'profile entries, then eligible project entries (values never resolved)',
        image: 'profile',
        init: 'profile',
        isolation: 'profile',
        network: 'profile (project values ignored)',
        permissions: 'profile',
        plugins: 'profile',
        ports: 'profile',
        profile: 'selected profile directory',
        services: 'profile',
        ssh: 'profile',
        state: 'profile',
        stateIsolation: 'profile',
      },
    });
    expect(
      explainProjectEnvEntry('SAFE_FORWARD', profile.allowProjectEnvForward),
    ).toEqual({ eligible: true, kind: 'forward', name: 'SAFE_FORWARD' });
    expect(explainProjectEnvEntry(`TOKEN=\${HOST_SECRET}`)).toEqual({
      disposition: 'rejected',
      eligible: false,
      name: 'TOKEN',
      reason: 'project env interpolation is not allowed',
    });
  });

  it('redacts every env literal regardless of key name, including service env', () => {
    expect(redactLiteral('public-but-literal')).toBe('<redacted>');
    expect(
      redactServiceEnv({
        db: { env: { MODE: 'quiet', PASSWORD: 'secret' }, image: 'db' },
      }),
    ).toEqual({
      db: {
        env: { MODE: '<redacted>', PASSWORD: '<redacted>' },
        image: 'db',
      },
    });
  });

  it('reports an empty init override when project init is omitted or trust-blocked', () => {
    expect(
      explainConfig(profile, { ...project, init: undefined, merge: 'override' })
        .sources.init,
    ).toBe('project (empty override)');
    expect(
      explainConfig(profile, {
        ...project,
        init: ['echo blocked'],
        merge: 'override',
      }).sources.init,
    ).toBe('project (empty override)');
    expect(
      explainConfig(
        { ...profile, allowProjectInit: true },
        { ...project, init: ['echo allowed'], merge: 'override' },
      ).sources.init,
    ).toBe('project (override)');
  });

  it('marks isolated project config wholly ignored', () => {
    expect(
      explainConfig({ ...profile, isolation: true }, project).ignored,
    ).toEqual([
      {
        path: '.ccpod.yml',
        reason: 'profile isolation disables project config',
      },
    ]);
  });
});
