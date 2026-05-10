import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyOverlay,
  countOverlayFields,
  loadOverlay,
  OVERLAY_FILENAME,
} from '../../../src/config/overlay.ts';
import type { ProfileOverlay } from '../../../src/config/schema.ts';
import type { ProfileConfig } from '../../../src/types/index.ts';

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    auth: { keyEnv: 'ANTHROPIC_API_KEY', type: 'api-key' },
    claudeArgs: [],
    config: { overlay: true, path: '/tmp/cfg', source: 'local', sync: 'daily' },
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

describe('loadOverlay', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccpod-overlay-'));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it('returns null when no overlay file exists', () => {
    expect(loadOverlay(dir)).toBeNull();
  });

  it('returns null on empty file', () => {
    writeFileSync(join(dir, OVERLAY_FILENAME), '');
    expect(loadOverlay(dir)).toBeNull();
  });

  it('parses a valid overlay', () => {
    writeFileSync(
      join(dir, OVERLAY_FILENAME),
      `plugins:\n  - foo\n  - bar\nnetwork:\n  policy: restricted\n  allow: [github.com]\n`,
    );
    const overlay = loadOverlay(dir);
    expect(overlay?.plugins).toEqual(['foo', 'bar']);
    expect(overlay?.network?.policy).toBe('restricted');
    expect(overlay?.network?.allow).toEqual(['github.com']);
  });

  it('rejects disallowed fields by ignoring them (no auth/name/state)', () => {
    writeFileSync(
      join(dir, OVERLAY_FILENAME),
      `plugins: [a]\nauth:\n  type: api-key\n`,
    );
    const overlay = loadOverlay(dir);
    // schema strips unknown keys; auth is not a valid overlay field
    expect(
      (overlay as unknown as Record<string, unknown>).auth,
    ).toBeUndefined();
    expect(overlay?.plugins).toEqual(['a']);
  });

  it('throws on invalid yaml', () => {
    writeFileSync(join(dir, OVERLAY_FILENAME), 'plugins: : :\n');
    expect(() => loadOverlay(dir)).toThrow();
  });

  it('throws on schema-invalid values', () => {
    writeFileSync(
      join(dir, OVERLAY_FILENAME),
      `network:\n  policy: nonsense\n`,
    );
    expect(() => loadOverlay(dir)).toThrow();
  });
});

describe('applyOverlay', () => {
  it('plugins are unioned and deduped', () => {
    const profile = makeProfile({ plugins: ['a', 'b'] });
    const overlay: ProfileOverlay = { plugins: ['b', 'c'] };
    const result = applyOverlay(profile, overlay);
    expect(result.plugins).toEqual(['a', 'b', 'c']);
  });

  it('image is overridden by overlay', () => {
    const profile = makeProfile({
      image: { dockerfile: 'Dockerfile', use: 'local:1' },
    });
    const overlay: ProfileOverlay = { image: { use: 'team:pinned' } };
    const result = applyOverlay(profile, overlay);
    expect(result.image.use).toBe('team:pinned');
    // dockerfile preserved when overlay only sets `use`
    expect(result.image.dockerfile).toBe('Dockerfile');
  });

  it('network policy: overlay wins, allow-lists union+dedupe', () => {
    const profile = makeProfile({
      network: { allow: ['github.com'], policy: 'full' },
    });
    const overlay: ProfileOverlay = {
      network: { allow: ['github.com', 'npmjs.org'], policy: 'restricted' },
    };
    const result = applyOverlay(profile, overlay);
    expect(result.network.policy).toBe('restricted');
    expect(result.network.allow).toEqual(['github.com', 'npmjs.org']);
  });

  it('services merge by key, overlay wins on conflict', () => {
    const profile = makeProfile({
      services: { postgres: { image: 'postgres:16' } },
    });
    const overlay: ProfileOverlay = {
      services: {
        postgres: { image: 'postgres:17' },
        redis: { image: 'redis:7' },
      },
    };
    const result = applyOverlay(profile, overlay);
    expect(result.services.postgres?.image).toBe('postgres:17');
    expect(result.services.redis?.image).toBe('redis:7');
  });

  it('claudeArgs and init concat without dedup', () => {
    const profile = makeProfile({
      claudeArgs: ['--flag', 'a'],
      init: ['echo hello'],
    });
    const overlay: ProfileOverlay = {
      claudeArgs: ['--flag', 'b'],
      init: ['echo world'],
    };
    const result = applyOverlay(profile, overlay);
    expect(result.claudeArgs).toEqual(['--flag', 'a', '--flag', 'b']);
    expect(result.init).toEqual(['echo hello', 'echo world']);
  });

  it('permissions preset: overlay overrides profile preset', () => {
    const profile = makeProfile({ permissions: 'conservative' });
    const overlay: ProfileOverlay = { permissions: 'moderate' };
    expect(applyOverlay(profile, overlay).permissions).toBe('moderate');
  });

  it('permissions: undefined overlay leaves profile preset alone', () => {
    const profile = makeProfile({ permissions: 'moderate' });
    expect(applyOverlay(profile, {}).permissions).toBe('moderate');
  });

  it('ssh: only specified keys override, others preserved', () => {
    const profile = makeProfile({
      ssh: { agentForward: false, mountSshDir: false },
    });
    const overlay: ProfileOverlay = { ssh: { agentForward: true } };
    const result = applyOverlay(profile, overlay);
    expect(result.ssh).toEqual({ agentForward: true, mountSshDir: false });
  });

  it('ports.list concat, autoDetectMcp overridable', () => {
    const profile = makeProfile({
      ports: { autoDetectMcp: true, list: ['3000:3000'] },
    });
    const overlay: ProfileOverlay = {
      ports: { autoDetectMcp: false, list: ['4000:4000'] },
    };
    const result = applyOverlay(profile, overlay);
    expect(result.ports.list).toEqual(['3000:3000', '4000:4000']);
    expect(result.ports.autoDetectMcp).toBe(false);
  });

  it('auth, name, state are never touched by overlay', () => {
    const profile = makeProfile({
      auth: { keyEnv: 'MY_KEY', type: 'api-key' },
      name: 'local-name',
      state: 'persistent',
    });
    const result = applyOverlay(profile, { plugins: ['x'] });
    expect(result.auth.keyEnv).toBe('MY_KEY');
    expect(result.name).toBe('local-name');
    expect(result.state).toBe('persistent');
  });

  it('empty overlay is a no-op', () => {
    const profile = makeProfile({ plugins: ['a'] });
    const result = applyOverlay(profile, {});
    expect(result).toEqual(profile);
  });
});

describe('countOverlayFields', () => {
  it('counts only defined fields', () => {
    expect(countOverlayFields({})).toBe(0);
    expect(countOverlayFields({ plugins: ['a'] })).toBe(1);
    expect(
      countOverlayFields({ network: { policy: 'full' }, plugins: [] }),
    ).toBe(2);
  });
});
