import type { PermissionsPreset } from '../types/index.ts';

// Expands to Claude Code settings.json `permissions.allow` entries.
// Applied as the lowest-priority layer — profile and project settings override it.
const PRESET_ALLOW: Record<PermissionsPreset, string[]> = {
  // Read-only tools: no prompts for inspection, but writes and bash still prompt.
  conservative: ['Read(*)', 'Glob(*)', 'Grep(*)'],
  // All file ops + bash: no prompts for typical dev work.
  moderate: [
    'Bash(*)',
    'Read(*)',
    'Write(*)',
    'Edit(*)',
    'MultiEdit(*)',
    'Glob(*)',
    'Grep(*)',
  ],
  // All tools including network: Docker provides the trust boundary.
  permissive: [
    'Bash(*)',
    'Edit(*)',
    'Glob(*)',
    'Grep(*)',
    'MultiEdit(*)',
    'Read(*)',
    'WebFetch(*)',
    'WebSearch(*)',
    'Write(*)',
  ],
};

export function expandPermissionsPreset(
  preset: PermissionsPreset | undefined,
): { permissions?: { allow: string[] } } {
  if (!preset) {
    return {};
  }
  return { permissions: { allow: PRESET_ALLOW[preset] } };
}
