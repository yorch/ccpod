import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { ProfileConfigInput } from '../config/schema.ts';
import {
  ensureCcpodDirs,
  PROFILES_DIR,
  profileExists,
} from '../profile/manager.ts';
import { detectRuntime } from '../runtime/detector.ts';

const DEFAULT_IMAGE = 'ghcr.io/yorch/ccpod:latest';

export async function runWizard(profileName = 'default'): Promise<void> {
  console.log(chalk.bold('\nccpod setup wizard\n'));

  const mode = (await select({
    choices: [
      {
        name: 'Quick — auth only, sensible defaults for everything else',
        value: 'quick',
      },
      {
        name: 'Full — configure network, state, SSH, image, and more',
        value: 'full',
      },
    ],
    message: 'Setup mode',
  })) as 'full' | 'quick';

  const totalSteps = mode === 'quick' ? 3 : 8;

  // Step 1 — runtime detection (auto)
  console.log();
  console.log(chalk.dim('Detecting container runtime...'));
  try {
    const runtime = detectRuntime();
    console.log(
      chalk.green(`✓ [1/${totalSteps}] ${capitalize(runtime.name)} detected`) +
        chalk.dim(` (${runtime.socketPath})`),
    );
  } catch {
    console.log(
      chalk.yellow(
        `⚠ [1/${totalSteps}] No runtime detected — install Docker, OrbStack, Colima, or Podman before running containers.`,
      ),
    );
  }

  // Step 2 — auth
  console.log();
  const authMethod = await select({
    choices: [
      { name: 'API key — environment variable', value: 'env' },
      { name: 'API key — file on disk', value: 'file' },
      { name: 'OAuth (browser login via claude)', value: 'oauth' },
    ],
    message: `[2/${totalSteps}] Auth method`,
  });

  let authConfig: ProfileConfigInput['auth'];
  if (authMethod === 'env') {
    const keyEnv = await input({
      default: 'ANTHROPIC_API_KEY',
      message: '     Env var name',
    });
    authConfig = { keyEnv, type: 'api-key' };
  } else if (authMethod === 'file') {
    const keyFile = await input({
      default: '~/.anthropic/api_key',
      message: '     Key file path',
    });
    authConfig = { keyFile, type: 'api-key' };
  } else {
    authConfig = { type: 'oauth' };
    console.log(
      chalk.dim(
        `     OAuth tokens will be stored in ~/.ccpod/credentials/${profileName}/`,
      ),
    );
  }

  // Quick mode — defaults for everything else
  if (mode === 'quick') {
    return writeProfile(profileName, totalSteps, {
      auth: authConfig,
      config: buildEmptyConfig(profileName),
      image: { use: DEFAULT_IMAGE },
      network: { allow: [], policy: 'full' },
      ssh: { agentForward: true, mountSshDir: false },
      state: 'ephemeral',
    });
  }

  // Full mode — steps 3–7

  // Step 3 — config source
  console.log();
  const configSource = await select({
    choices: [
      { name: 'Start empty', value: 'empty' },
      { name: 'Local directory', value: 'local' },
      { name: 'Git repository', value: 'git' },
    ],
    message: `[3/${totalSteps}] Config source (CLAUDE.md, settings.json, skills, extensions)`,
  });

  let configConfig: ProfileConfigInput['config'];
  if (configSource === 'empty') {
    configConfig = buildEmptyConfig(profileName);
  } else if (configSource === 'local') {
    const path = await input({
      message: '     Config directory path',
      validate: (v) => v.trim() !== '' || 'Path cannot be empty',
    });
    configConfig = { path, source: 'local' };
  } else {
    const repo = await input({
      message: '     Git repo URL',
      validate: (v) => v.trim() !== '' || 'Repo URL cannot be empty',
    });
    const ref = await input({
      default: 'main',
      message: '     Branch / tag / ref',
    });
    const sync = (await select({
      choices: [
        { name: 'Daily (once per day)', value: 'daily' },
        { name: 'Always (every run)', value: 'always' },
        { name: 'Pin (never update)', value: 'pin' },
      ],
      message: '     Sync strategy',
    })) as 'always' | 'daily' | 'pin';
    configConfig = { ref, repo, source: 'git', sync };
  }

  // Step 4 — network policy
  console.log();
  const networkPolicy = (await select({
    choices: [
      { name: 'Full — unrestricted outbound', value: 'full' },
      { name: 'Restricted — iptables allow-list', value: 'restricted' },
    ],
    message: `[4/${totalSteps}] Default network policy`,
  })) as 'full' | 'restricted';

  // Step 5 — state persistence
  console.log();
  const state = (await select({
    choices: [
      {
        name: 'Ephemeral — history lost when container is removed',
        value: 'ephemeral',
      },
      {
        name: 'Persistent — history survives container removal (Docker volume)',
        value: 'persistent',
      },
    ],
    message: `[5/${totalSteps}] Session state`,
  })) as 'ephemeral' | 'persistent';

  // Step 6 — SSH
  console.log();
  console.log(chalk.dim(`[6/${totalSteps}] SSH configuration`));
  const agentForward = await confirm({
    default: true,
    message: '     Forward host SSH agent into container?',
  });
  const mountSshDir = await confirm({
    default: false,
    message: '     Bind-mount ~/.ssh (read-only) for direct key access?',
  });

  // Step 7 — image
  console.log();
  const imageRef = await input({
    default: DEFAULT_IMAGE,
    message: `[7/${totalSteps}] Docker image`,
  });

  return writeProfile(profileName, totalSteps, {
    auth: authConfig,
    config: configConfig,
    image: { use: imageRef },
    network: { allow: [], policy: networkPolicy },
    ssh: { agentForward, mountSshDir },
    state,
  });
}

function buildEmptyConfig(profileName: string): ProfileConfigInput['config'] {
  return { path: join(PROFILES_DIR, profileName, 'config'), source: 'local' };
}

async function writeProfile(
  profileName: string,
  totalSteps: number,
  opts: {
    auth: ProfileConfigInput['auth'];
    config: ProfileConfigInput['config'];
    network: NonNullable<ProfileConfigInput['network']>;
    state: 'ephemeral' | 'persistent';
    ssh: NonNullable<ProfileConfigInput['ssh']>;
    image: NonNullable<ProfileConfigInput['image']>;
  },
): Promise<void> {
  const profileDir = join(PROFILES_DIR, profileName);

  console.log();
  if (profileExists(profileName)) {
    const overwrite = await confirm({
      default: false,
      message: `[${totalSteps}/${totalSteps}] Profile '${profileName}' already exists. Overwrite?`,
    });
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  } else {
    const ok = await confirm({
      default: true,
      message: `[${totalSteps}/${totalSteps}] Write profile '${profileName}' to ${profileDir}?`,
    });
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  ensureCcpodDirs();
  mkdirSync(profileDir, { recursive: true });
  if (opts.config?.source === 'local' && opts.config.path) {
    mkdirSync(opts.config.path, { recursive: true });
  }

  const profile: ProfileConfigInput = {
    auth: opts.auth,
    claudeArgs: [],
    config: opts.config,
    env: [],
    image: opts.image,
    name: profileName,
    network: opts.network,
    plugins: [],
    ports: { autoDetectMcp: true, list: [] },
    services: {},
    ssh: opts.ssh,
    state: opts.state,
  };

  writeFileSync(
    join(profileDir, 'profile.yml'),
    buildAnnotatedProfileYaml(profile),
    'utf8',
  );

  console.log(chalk.green(`\n✓ Profile '${profileName}' created.`));
  console.log(chalk.dim(`  ${join(profileDir, 'profile.yml')}`));
  console.log(chalk.dim("\nRun 'ccpod run' to launch Claude Code.\n"));
}

export function q(val: string): string {
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
  s.push(`name: ${q(profile.name)}`);
  s.push('');

  s.push('# Authentication with the Anthropic API.');
  s.push(
    '# type: api-key (env var or file on disk) | oauth (browser login via claude)',
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
      s.push(`  keyFile: ${q(profile.auth.keyFile)}`);
    } else {
      s.push(`  keyEnv: ${profile.auth?.keyEnv ?? 'ANTHROPIC_API_KEY'}`);
    }
  }
  s.push('');

  s.push(
    '# Extra CLI flags passed to the claude command on every run (profile-level baseline).',
  );
  s.push('# Example: ["--verbose", "--model", "claude-opus-4-5"]');
  s.push(`claudeArgs: []`);
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
  if (profile.config?.path) s.push(`  path: ${q(profile.config.path)}`);
  if (profile.config?.repo) s.push(`  repo: ${q(profile.config.repo)}`);
  if (profile.config?.ref) s.push(`  ref: ${q(profile.config.ref)}`);
  if (profile.config?.sync) s.push(`  sync: ${profile.config.sync}`);
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
  s.push(`  use: ${q(profile.image?.use ?? DEFAULT_IMAGE)}`);
  if (profile.image?.dockerfile)
    s.push(`  dockerfile: ${q(profile.image.dockerfile)}`);
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

  return s.join('\n');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
