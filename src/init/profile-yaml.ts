import type { ProfileConfigInput } from '../config/schema.ts';
import { OFFICIAL_IMAGE } from '../constants.ts';

export function yamlQuote(val: string): string {
  if (/[\s:#[\]{},!*&|>%@`?]/.test(val) || val.startsWith('-')) {
    return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return val;
}

export function buildAnnotatedProfileYaml(profile: ProfileConfigInput): string {
  const s: string[] = [];

  s.push(
    '# Profile identifier — used in container/volume names and credential paths.',
  );
  s.push(`name: ${yamlQuote(profile.name)}`);
  s.push('');

  s.push(
    '# Optional human-readable description shown in `ccpod profile list`.',
  );
  s.push(
    `description: ${profile.description ? yamlQuote(profile.description) : '""'}`,
  );
  s.push('');

  s.push('# Authentication with the Anthropic API.');
  s.push(
    '# type: api-key (env var or file on disk) | oauth (browser login via claude) | proxy (share host OAuth session)',
  );
  if (profile.auth?.type === 'api-key') {
    if (profile.auth.keyFile) {
      s.push('# keyFile: path to a plaintext file containing the API key');
    } else {
      s.push('# keyEnv: name of the host env var that holds the API key');
    }
  }
  s.push('auth:');
  s.push(`  type: ${profile.auth?.type ?? 'api-key'}`);
  if (profile.auth?.type === 'api-key') {
    if (profile.auth.keyFile) {
      s.push(`  keyFile: ${yamlQuote(profile.auth.keyFile)}`);
    } else {
      s.push(`  keyEnv: ${profile.auth?.keyEnv ?? 'ANTHROPIC_API_KEY'}`);
    }
  }
  s.push('');

  s.push(
    '# Extra CLI flags passed to the claude command on every run (profile-level baseline).',
  );
  s.push('# Example: ["--verbose", "--model", "claude-opus-4-5"]');
  s.push(
    `claudeArgs: ${profile.claudeArgs?.length ? JSON.stringify(profile.claudeArgs) : '[]'}`,
  );
  s.push('');

  s.push(
    '# Source for Claude config files (CLAUDE.md, settings.json, skills, extensions).',
  );
  s.push('# source: local — read from a directory on disk');
  s.push(
    '# source: git   — clone/pull from a git repo; supports ref and sync strategy',
  );
  s.push('# sync: always | daily | pin — how often to pull updates (git only)');
  s.push('config:');
  s.push(`  source: ${profile.config?.source}`);
  if (profile.config?.path) {
    s.push(`  path: ${yamlQuote(profile.config.path)}`);
  }
  if (profile.config?.repo) {
    s.push(`  repo: ${yamlQuote(profile.config.repo)}`);
  }
  if (profile.config?.ref) {
    s.push(`  ref: ${yamlQuote(profile.config.ref)}`);
  }
  if (profile.config?.sync) {
    s.push(`  sync: ${profile.config.sync}`);
  }
  s.push('');

  s.push('# Extra environment variables passed into the container.');
  s.push('# Format: KEY=VALUE (explicit) or KEY (inherit value from host).');
  s.push(`env: []`);
  s.push('');

  s.push('# Docker image used to run Claude Code.');
  s.push('# use: image reference (registry/repo:tag)');
  s.push(
    '# dockerfile: path to a local Dockerfile to build instead of pulling.',
  );
  s.push('image:');
  s.push(`  use: ${yamlQuote(profile.image?.use ?? OFFICIAL_IMAGE)}`);
  if (profile.image?.dockerfile) {
    s.push(`  dockerfile: ${yamlQuote(profile.image.dockerfile)}`);
  }
  s.push('');

  s.push(
    '# Shell commands run inside the container as the node user in /workspace',
  );
  s.push('# after config is seeded and before Claude starts. Exit on error.');
  s.push(
    '# Example: ["npm install", "git config --global user.email dev@example.com"]',
  );
  s.push(`init: ${profile.init?.length ? JSON.stringify(profile.init) : '[]'}`);
  s.push('');

  s.push('# Network policy applied to the container.');
  s.push('# policy: full — unrestricted outbound access');
  s.push(
    "# policy: restricted — iptables allow-list; add permitted hosts/CIDRs to 'allow'",
  );
  s.push('network:');
  s.push(`  policy: ${profile.network?.policy ?? 'full'}`);
  s.push(`  allow: []`);
  s.push('');

  s.push(
    '# Claude Code plugins to install on first run (delta-installed; no reinstall if already present).',
  );
  s.push('# Example: ["mcp-server-brave-search", "mcp-server-filesystem"]');
  s.push(`plugins: []`);
  s.push('');

  s.push('# Port mappings and MCP server discovery.');
  s.push('# autoDetectMcp: automatically expose ports declared in .mcp.json');
  s.push('# list: additional host:container port pairs, e.g. "8080:8080"');
  s.push('ports:');
  s.push(`  autoDetectMcp: ${profile.ports?.autoDetectMcp ?? true}`);
  s.push(`  list: []`);
  s.push('');

  s.push(
    '# Sidecar containers started alongside Claude Code (databases, proxies, etc.).',
  );
  s.push(
    '# Each key is a service name. Fields: image (required), ports, volumes, env.',
  );
  s.push('services: {}');
  s.push('');

  s.push('# SSH configuration.');
  s.push(
    '# agentForward: forward the host SSH agent socket into the container',
  );
  s.push('# mountSshDir: bind-mount ~/.ssh (read-only) for direct key access');
  s.push('ssh:');
  s.push(`  agentForward: ${profile.ssh?.agentForward ?? true}`);
  s.push(`  mountSshDir: ${profile.ssh?.mountSshDir ?? false}`);
  s.push('');

  s.push('# Session state persistence across container restarts.');
  s.push(
    '# ephemeral:  conversation history and todos lost when container is removed',
  );
  s.push(
    '# persistent: stored in a named Docker volume; survives container removal',
  );
  s.push(`state: ${profile.state ?? 'ephemeral'}`);
  s.push('');

  s.push(
    '# When true, project .ccpod.yml, CLAUDE.md, and .claude/settings.json are ignored.',
  );
  s.push(
    '# The profile config is used as-is, regardless of the project being run.',
  );
  s.push(`isolation: ${profile.isolation ?? false}`);
  s.push('');

  s.push(
    '# Injects a Claude Code permissions preset as the lowest-priority layer.',
  );
  s.push('# Profile and project settings.json always override the preset.');
  s.push(
    '# conservative: allow Edit, Write (file edits skip prompts; Bash still prompts)',
  );
  s.push(
    '# moderate:     allow Bash, Edit, Write (no prompts for typical dev work)',
  );
  s.push(
    '# permissive:   bypassPermissions mode — skips all prompts (Docker is the trust boundary)',
  );
  if (profile.permissions) {
    s.push(`permissions: ${profile.permissions}`);
  } else {
    s.push('# permissions: moderate');
  }
  s.push('');

  return s.join('\n');
}
