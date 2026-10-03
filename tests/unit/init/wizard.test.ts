import { describe, expect, it } from 'bun:test';
import { parse as yamlParse } from 'yaml';
import type { ProfileConfigInput } from '../../../src/config/schema.ts';
import {
  buildAnnotatedProfileYaml,
  yamlQuote,
} from '../../../src/init/profile-yaml.ts';

const baseProfile: ProfileConfigInput = {
  auth: { keyEnv: 'ANTHROPIC_API_KEY', type: 'api-key' },
  config: {
    path: '/home/user/.ccpod/profiles/default/config',
    source: 'local',
  },
  env: [],
  image: { use: 'ghcr.io/yorch/ccpod:latest' },
  init: [],
  name: 'default',
  network: { allow: [], policy: 'full' },
  plugins: [],
  ports: { autoDetectMcp: true, list: [] },
  services: {},
  ssh: { agentForward: true, mountSshDir: false },
  state: 'ephemeral',
};

describe('yamlQuote()', () => {
  it('passes plain strings through unchanged', () => {
    expect(yamlQuote('simple')).toBe('simple');
    expect(yamlQuote('api-key')).toBe('api-key');
    expect(yamlQuote('ANTHROPIC_API_KEY')).toBe('ANTHROPIC_API_KEY');
  });

  it('quotes strings with spaces', () => {
    expect(yamlQuote('path with spaces')).toBe('"path with spaces"');
  });

  it('quotes strings with YAML special chars', () => {
    expect(yamlQuote('ghcr.io/yorch/ccpod:latest')).toBe(
      '"ghcr.io/yorch/ccpod:latest"',
    );
    expect(yamlQuote('key: value')).toBe('"key: value"');
    expect(yamlQuote('[array]')).toBe('"[array]"');
  });

  it('escapes embedded double quotes', () => {
    expect(yamlQuote('say "hello"')).toBe('"say \\"hello\\""');
  });

  it('escapes backslashes when quoting is triggered', () => {
    // space triggers quoting; backslash in value must be double-escaped
    expect(yamlQuote('C:\\path with spaces')).toBe('"C:\\\\path with spaces"');
    // colon triggers quoting; backslash must be escaped before quote-escaping
    expect(yamlQuote('key: C:\\value')).toBe('"key: C:\\\\value"');
  });

  it('quotes strings starting with YAML indicator characters', () => {
    expect(yamlQuote('!important')).toBe('"!important"');
    expect(yamlQuote('*alias')).toBe('"*alias"');
    expect(yamlQuote('-flag')).toBe('"-flag"');
  });
});

describe('buildAnnotatedProfileYaml()', () => {
  it('produces valid YAML that round-trips through the parser', () => {
    const yaml = buildAnnotatedProfileYaml(baseProfile);
    expect(() => yamlParse(yaml)).not.toThrow();
    const parsed = yamlParse(yaml);
    expect(parsed.name).toBe('default');
    expect(parsed.auth.type).toBe('api-key');
    expect(parsed.auth.keyEnv).toBe('ANTHROPIC_API_KEY');
    expect(parsed.config.source).toBe('local');
    expect(parsed.state).toBe('ephemeral');
    expect(parsed.network.policy).toBe('full');
    expect(parsed.ports.autoDetectMcp).toBe(true);
    expect(parsed.ssh.agentForward).toBe(true);
    expect(parsed.ssh.mountSshDir).toBe(false);
  });

  it('includes comments for every section', () => {
    const yaml = buildAnnotatedProfileYaml(baseProfile);
    const lines = yaml.split('\n');
    for (const keyword of [
      'name:',
      'auth:',
      'config:',
      'env:',
      'image:',
      'network:',
      'ports:',
      'services:',
      'ssh:',
      'state:',
    ]) {
      const keyLineIdx = lines.findIndex(
        (l) => l === keyword || l.startsWith(`${keyword} `),
      );
      expect(keyLineIdx).toBeGreaterThan(0);
      // At least one of the preceding non-empty lines must be a comment
      const precedingLines = lines
        .slice(0, keyLineIdx)
        .filter((l) => l.trim() !== '');
      const lastPreceding = precedingLines[precedingLines.length - 1] ?? '';
      expect(lastPreceding.trimStart().startsWith('#')).toBe(true);
    }
  });

  describe('auth variants', () => {
    it('renders api-key with keyEnv', () => {
      const yaml = buildAnnotatedProfileYaml(baseProfile);
      expect(yaml).toContain('type: api-key');
      expect(yaml).toContain('keyEnv: ANTHROPIC_API_KEY');
      expect(yaml).not.toContain('keyFile');
    });

    it('renders api-key with keyFile', () => {
      const profile: ProfileConfigInput = {
        ...baseProfile,
        auth: { keyFile: '/home/user/.keys/anthropic', type: 'api-key' },
      };
      const yaml = buildAnnotatedProfileYaml(profile);
      expect(yaml).toContain('type: api-key');
      expect(yaml).toContain('keyFile:');
      expect(yaml).not.toContain('keyEnv');
    });

    it('renders oauth without key fields', () => {
      const profile: ProfileConfigInput = {
        ...baseProfile,
        auth: { type: 'oauth' },
      };
      const yaml = buildAnnotatedProfileYaml(profile);
      expect(yaml).toContain('type: oauth');
      expect(yaml).not.toContain('keyEnv');
      expect(yaml).not.toContain('keyFile');
    });
  });

  describe('config source variants', () => {
    it('renders local source with path', () => {
      const yaml = buildAnnotatedProfileYaml(baseProfile);
      expect(yaml).toContain('source: local');
      expect(yaml).toContain('  path:');
      expect(yaml).not.toContain('\n  repo:');
      expect(yaml).not.toContain('\n  ref:');
    });

    it('renders git source with repo, ref, sync', () => {
      const profile: ProfileConfigInput = {
        ...baseProfile,
        config: {
          ref: 'main',
          repo: 'https://github.com/org/config',
          source: 'git',
          sync: 'daily',
        },
      };
      const yaml = buildAnnotatedProfileYaml(profile);
      expect(yaml).toContain('source: git');
      expect(yaml).toContain('repo:');
      expect(yaml).toContain('ref: main');
      expect(yaml).toContain('sync: daily');
      expect(yaml).not.toContain('path:');
      const parsed = yamlParse(yaml);
      expect(parsed.config.source).toBe('git');
      expect(parsed.config.repo).toBe('https://github.com/org/config');
      expect(parsed.config.ref).toBe('main');
      expect(parsed.config.sync).toBe('daily');
      expect(parsed.config.path).toBeUndefined();
    });
  });

  it('renders restricted network policy', () => {
    const profile: ProfileConfigInput = {
      ...baseProfile,
      network: { allow: [], policy: 'restricted' },
    };
    const yaml = buildAnnotatedProfileYaml(profile);
    expect(yaml).toContain('policy: restricted');
  });

  it('renders persistent state', () => {
    const profile: ProfileConfigInput = { ...baseProfile, state: 'persistent' };
    const yaml = buildAnnotatedProfileYaml(profile);
    expect(yaml).toContain('state: persistent');
  });

  it('quotes image refs containing colons', () => {
    const yaml = buildAnnotatedProfileYaml(baseProfile);
    expect(yaml).toContain('"ghcr.io/yorch/ccpod:latest"');
  });

  it('ends with a trailing newline', () => {
    const yaml = buildAnnotatedProfileYaml(baseProfile);
    expect(yaml.endsWith('\n')).toBe(true);
  });
});
