import { describe, expect, it } from 'bun:test';
import deepmerge from 'deepmerge';
import { expandPermissionsPreset } from '../../../src/config/permissions.ts';

describe('expandPermissionsPreset', () => {
  it('returns empty object when preset is undefined', () => {
    expect(expandPermissionsPreset(undefined)).toEqual({});
  });

  it('conservative allows only read-only tools', () => {
    const result = expandPermissionsPreset('conservative') as {
      permissions: { allow: string[] };
    };
    expect(result.permissions.allow).toEqual(['Read(*)', 'Glob(*)', 'Grep(*)']);
    expect(result.permissions.allow).not.toContain('Bash(*)');
    expect(result.permissions.allow).not.toContain('Write(*)');
  });

  it('moderate allows file ops and bash but not network', () => {
    const result = expandPermissionsPreset('moderate') as {
      permissions: { allow: string[] };
    };
    expect(result.permissions.allow).toContain('Bash(*)');
    expect(result.permissions.allow).toContain('Write(*)');
    expect(result.permissions.allow).not.toContain('WebSearch(*)');
    expect(result.permissions.allow).not.toContain('WebFetch(*)');
  });

  it('permissive allows all tools including network', () => {
    const result = expandPermissionsPreset('permissive') as {
      permissions: { allow: string[] };
    };
    expect(result.permissions.allow).toContain('Bash(*)');
    expect(result.permissions.allow).toContain('WebSearch(*)');
    expect(result.permissions.allow).toContain('WebFetch(*)');
  });

  it('profile settings union with preset (arrays deduplicated)', () => {
    const preset = expandPermissionsPreset('conservative');
    const profileSettings = {
      permissions: { allow: ['Bash(*)', 'Write(*)', 'Read(*)'] },
    };
    const merged = deepmerge(preset, profileSettings, {
      arrayMerge: (dest: unknown[], src: unknown[]) => {
        const combined = [...dest, ...src];
        return combined.every((item) => typeof item === 'string')
          ? [...new Set(combined as string[])]
          : combined;
      },
    }) as { permissions: { allow: string[] } };
    // Arrays union — preset entries survive, profile entries added, duplicates removed
    expect(merged.permissions.allow).toContain('Bash(*)');
    expect(merged.permissions.allow).toContain('Write(*)');
    expect(merged.permissions.allow).toContain('Read(*)');
    // No duplicate Read(*) from both preset and profileSettings
    expect(merged.permissions.allow.filter((e) => e === 'Read(*)').length).toBe(
      1,
    );
  });

  it('profile empty settings.json does not clobber preset', () => {
    const preset = expandPermissionsPreset('moderate');
    const merged = deepmerge(preset, {}) as {
      permissions: { allow: string[] };
    };
    expect(merged.permissions.allow).toContain('Bash(*)');
  });
});
