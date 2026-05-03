import { describe, expect, it } from 'bun:test';
import deepmerge from 'deepmerge';
import { expandPermissionsPreset } from '../../../src/config/permissions.ts';

describe('expandPermissionsPreset', () => {
  it('returns empty object when preset is undefined', () => {
    expect(expandPermissionsPreset(undefined)).toEqual({});
  });

  it('conservative allows Edit and Write but not Bash or network', () => {
    const result = expandPermissionsPreset('conservative');
    expect(result.permissions?.allow).toEqual(['Edit', 'Write']);
    expect(result.permissions?.allow).not.toContain('Bash');
    expect(result.permissions?.allow).not.toContain('WebSearch');
    expect(result.permissions?.defaultMode).toBeUndefined();
  });

  it('moderate allows Bash, Edit, Write but not network', () => {
    const result = expandPermissionsPreset('moderate');
    expect(result.permissions?.allow).toEqual(['Bash', 'Edit', 'Write']);
    expect(result.permissions?.allow).not.toContain('WebSearch');
    expect(result.permissions?.defaultMode).toBeUndefined();
  });

  it('permissive sets defaultMode bypassPermissions instead of listing tools', () => {
    const result = expandPermissionsPreset('permissive');
    expect(result.permissions?.defaultMode).toBe('bypassPermissions');
    expect(result.permissions?.allow).toBeUndefined();
  });

  it('profile settings union with preset allow list (arrays deduplicated)', () => {
    const preset = expandPermissionsPreset('conservative');
    const profileSettings = { permissions: { allow: ['Bash', 'Edit'] } };
    const merged = deepmerge(preset, profileSettings, {
      arrayMerge: (dest: unknown[], src: unknown[]) => {
        const combined = [...dest, ...src];
        return combined.every((item) => typeof item === 'string')
          ? [...new Set(combined as string[])]
          : combined;
      },
    }) as { permissions: { allow: string[] } };
    expect(merged.permissions.allow).toContain('Bash');
    expect(merged.permissions.allow).toContain('Edit');
    expect(merged.permissions.allow).toContain('Write');
    // No duplicate Edit
    expect(merged.permissions.allow.filter((e) => e === 'Edit').length).toBe(1);
  });

  it('profile empty settings.json does not clobber preset', () => {
    const preset = expandPermissionsPreset('moderate');
    const merged = deepmerge(preset, {}) as {
      permissions: { allow: string[] };
    };
    expect(merged.permissions.allow).toContain('Bash');
  });
});
