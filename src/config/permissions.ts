import type { PermissionsPreset } from '../types/index.ts';

type PermissionsBlock = { allow?: string[]; defaultMode?: string };

// Read, Glob, Grep require no permission in Claude Code — they're free tools.
// Only Bash, Edit, Write, WebFetch, WebSearch, NotebookEdit gate prompts.
const PRESETS: Record<PermissionsPreset, PermissionsBlock> = {
  // File edits/writes skip prompts; Bash still prompts.
  conservative: { allow: ['Edit', 'Write'] },
  // All typical dev ops skip prompts; network tools still prompt.
  moderate: { allow: ['Bash', 'Edit', 'Write'] },
  // Bypass all permission prompts — Docker provides the trust boundary.
  permissive: { defaultMode: 'bypassPermissions' },
};

export function expandPermissionsPreset(
  preset: PermissionsPreset | undefined,
): { permissions?: PermissionsBlock } {
  if (!preset) {
    return {};
  }
  return { permissions: PRESETS[preset] };
}
