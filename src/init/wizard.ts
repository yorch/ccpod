import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { parse } from 'yaml';
import {
  type ProfileConfigInput,
  profileConfigSchema,
} from '../config/schema.ts';
import { OFFICIAL_IMAGE } from '../constants.ts';
import { downloadOfficialDockerfile } from '../image/downloader.ts';
import {
  ensureCcpodDirs,
  getCredentialsDir,
  getProfileDir,
  listProfiles,
  profileExists,
} from '../profile/manager.ts';
import { detectRuntime } from '../runtime/detector.ts';

type DetectedAuth = {
  envKey: string | undefined;
  hostKeychainToken: string | undefined;
  profiles: Array<{ name: string; auth: ProfileConfigInput['auth'] }>;
};

function detectAuth(currentProfile: string): DetectedAuth {
  const envKey = process.env.ANTHROPIC_API_KEY
    ? 'ANTHROPIC_API_KEY'
    : undefined;

  let hostKeychainToken: string | undefined;
  if (process.platform === 'darwin') {
    try {
      hostKeychainToken =
        execFileSync(
          'security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000,
          },
        ).trim() || undefined;
    } catch {
      // not found or access denied
    }
  }

  const profiles: DetectedAuth['profiles'] = [];
  for (const name of listProfiles()) {
    if (name === currentProfile) {
      continue;
    }
    try {
      const raw = readFileSync(
        join(getProfileDir(name), 'profile.yml'),
        'utf8',
      );
      const parsed = parse(raw) as { auth?: unknown };
      const authResult = profileConfigSchema.shape.auth.safeParse(parsed?.auth);
      if (authResult.success) {
        profiles.push({ auth: authResult.data, name });
      }
    } catch {
      // skip unreadable profiles
    }
  }
  return { envKey, hostKeychainToken, profiles };
}

export async function runWizard(profileName = 'default'): Promise<void> {
  console.log(chalk.bold('\nccpod setup wizard\n'));

  if (profileExists(profileName)) {
    console.log(chalk.yellow(`Profile '${profileName}' already exists.`));
    const proceed = await confirm({
      default: false,
      message: 'Continue and overwrite it?',
    });
    if (!proceed) {
      console.log('Aborted.');
      return;
    }
    console.log();
  }

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

  const totalSteps = mode === 'quick' ? 3 : 9;

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
  const {
    envKey,
    hostKeychainToken,
    profiles: existingProfiles,
  } = detectAuth(profileName);

  const authChoices: { name: string; value: string }[] = [];
  if (hostKeychainToken) {
    authChoices.push({
      name: 'Use host Claude Code OAuth (macOS Keychain)',
      value: 'host-keychain',
    });
  }
  if (envKey) {
    authChoices.push({
      name: `API key — ${envKey} (detected in env)`,
      value: `detected:${envKey}`,
    });
  }
  for (const { name, auth } of existingProfiles) {
    const desc =
      auth?.type === 'oauth'
        ? 'OAuth'
        : auth?.keyFile
          ? `keyFile: ${auth.keyFile}`
          : `keyEnv: ${auth?.keyEnv ?? 'ANTHROPIC_API_KEY'}`;
    authChoices.push({
      name: `Copy auth from profile '${name}' (${desc})`,
      value: `profile:${name}`,
    });
  }
  authChoices.push(
    { name: 'API key — environment variable', value: 'env' },
    { name: 'API key — file on disk', value: 'file' },
    { name: 'OAuth (browser login via claude)', value: 'oauth' },
  );

  const authMethod = await select({
    choices: authChoices,
    message: `[2/${totalSteps}] Auth method`,
  });

  let authConfig: ProfileConfigInput['auth'];
  let credentialSourceProfile: string | undefined;
  let hostKeychainTokenToWrite: string | undefined;
  if (authMethod === 'host-keychain') {
    authConfig = { type: 'oauth' };
    hostKeychainTokenToWrite = hostKeychainToken;
  } else if (authMethod.startsWith('detected:')) {
    authConfig = {
      keyEnv: authMethod.slice('detected:'.length),
      type: 'api-key',
    };
  } else if (authMethod.startsWith('profile:')) {
    const sourceName = authMethod.slice('profile:'.length);
    const found = existingProfiles.find((p) => p.name === sourceName);
    if (!found) {
      console.warn(
        chalk.yellow(
          `     Profile '${sourceName}' not found; using default API key config.`,
        ),
      );
    }
    authConfig = found?.auth ?? {
      keyEnv: 'ANTHROPIC_API_KEY',
      type: 'api-key',
    };
    if (found?.auth?.type === 'oauth') {
      credentialSourceProfile = sourceName;
    }
  } else if (authMethod === 'env') {
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
    const written = await writeProfile(profileName, totalSteps, {
      auth: authConfig,
      config: buildEmptyConfig(profileName),
      createConfigDir: true,
      image: { use: OFFICIAL_IMAGE },
      network: { allow: [], policy: 'full' },
      ssh: { agentForward: true, mountSshDir: false },
      state: 'ephemeral',
    });
    if (written) {
      copyCredentials(credentialSourceProfile, profileName);
      writeKeychainCredentials(hostKeychainTokenToWrite, profileName);
    }
    return;
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
  let createConfigDir = false;
  if (configSource === 'empty') {
    configConfig = buildEmptyConfig(profileName);
    createConfigDir = true;
  } else if (configSource === 'local') {
    const path = await input({
      message: '     Config directory path',
      validate: (v) => v.trim() !== '' || 'Path cannot be empty',
    });
    configConfig = { path: path.trim(), source: 'local' };
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
    configConfig = { ref, repo: repo.trim(), source: 'git', sync };
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

  // Step 7 — isolation
  console.log();
  const isolation = await confirm({
    default: false,
    message: `[7/${totalSteps}] Isolate profile from project config? (ignore project .ccpod.yml, CLAUDE.md, and .claude/settings.json)`,
  });

  // Step 8 — image
  console.log();
  const imageChoice = (await select({
    choices: [
      {
        description: 'Pre-built, always up-to-date. Best for most users.',
        name: `Official image (${OFFICIAL_IMAGE})`,
        value: 'official',
      },
      {
        description:
          'Use any image from a registry (e.g. your own fork or a private image).',
        name: 'Custom image reference',
        value: 'custom',
      },
      {
        description:
          'Add tools, pin versions, or install packages. Requires a local build step.',
        name: 'Build your own — download Dockerfile for local customization',
        value: 'build',
      },
    ],
    message: `[8/${totalSteps}] Docker image`,
  })) as 'build' | 'custom' | 'official';

  let imageConfig: NonNullable<ProfileConfigInput['image']>;
  if (imageChoice === 'custom') {
    const imageRef = await input({
      message: '     Image reference',
      validate: (v) => v.trim() !== '' || 'Image reference cannot be empty',
    });
    imageConfig = { use: imageRef.trim() };
  } else if (imageChoice === 'build') {
    imageConfig = {
      dockerfile: '{{profile_dir}}/Dockerfile',
      use: 'build',
    };
  } else {
    imageConfig = { use: OFFICIAL_IMAGE };
  }

  const written = await writeProfile(profileName, totalSteps, {
    auth: authConfig,
    config: configConfig,
    createConfigDir,
    image: imageConfig,
    isolation,
    network: { allow: [], policy: networkPolicy },
    ssh: { agentForward, mountSshDir },
    state,
  });

  if (written) {
    copyCredentials(credentialSourceProfile, profileName);
    writeKeychainCredentials(hostKeychainTokenToWrite, profileName);
  }

  if (written && imageChoice === 'build') {
    const profileDir = getProfileDir(profileName);
    console.log();
    console.log(chalk.dim('Downloading Dockerfile and entrypoint.sh...'));
    try {
      await downloadOfficialDockerfile(profileDir);
      console.log(
        chalk.green(`✓ Dockerfile saved to ${join(profileDir, 'Dockerfile')}`),
      );
      console.log(
        chalk.green(
          `✓ entrypoint.sh saved to ${join(profileDir, 'entrypoint.sh')}`,
        ),
      );
      console.log(
        chalk.dim(
          `\nEdit ${join(profileDir, 'Dockerfile')}, then run: ccpod image build --apply`,
        ),
      );
    } catch (err) {
      console.log(
        chalk.yellow(
          `⚠ Download failed: ${err}. Run 'ccpod image init' manually.`,
        ),
      );
    }
  }
}

// Only these keys are needed for auth/identity — everything else (mcpServers,
// projects, recentFiles, etc.) belongs to the host and must not leak into containers.
// anonymousId is omitted intentionally: it's a telemetry identifier; containers
// should get a fresh one rather than inheriting the host's analytics identity.
const CLAUDE_JSON_KEEP_KEYS = [
  'oauthAccount',
  'userID',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'migrationVersion',
] as const;

function sanitizeClaudeJson(src: string): string {
  try {
    const parsed = JSON.parse(readFileSync(src, 'utf8')) as Record<
      string,
      unknown
    >;
    const filtered: Record<string, unknown> = {};
    for (const key of CLAUDE_JSON_KEEP_KEYS) {
      if (key in parsed) {
        filtered[key] = parsed[key];
      }
    }
    return JSON.stringify(filtered);
  } catch {
    return '{}';
  }
}

function copyCredentials(
  sourceProfile: string | undefined,
  destProfile: string,
): void {
  if (!sourceProfile) {
    return;
  }
  const srcDir = getCredentialsDir(sourceProfile);
  const destDir = getCredentialsDir(destProfile);
  const credFile = join(srcDir, '.credentials.json');
  try {
    const dest = join(destDir, '.credentials.json');
    copyFileSync(credFile, dest);
    chmodSync(dest, 0o600);
  } catch {
    // file absent — container may not have run yet; skip silently
  }
  const claudeJsonSrc = join(srcDir, '.claude.json');
  if (existsSync(claudeJsonSrc)) {
    try {
      const dest = join(destDir, '.claude.json');
      writeFileSync(dest, sanitizeClaudeJson(claudeJsonSrc), { mode: 0o600 });
    } catch {
      // skip if unreadable
    }
  }
}

function writeKeychainCredentials(
  token: string | undefined,
  destProfile: string,
): void {
  if (!token) {
    return;
  }
  const destDir = getCredentialsDir(destProfile);
  writeFileSync(join(destDir, '.credentials.json'), token, { mode: 0o600 });
  const hostClaudeJson = join(homedir(), '.claude.json');
  if (existsSync(hostClaudeJson)) {
    try {
      const dest = join(destDir, '.claude.json');
      writeFileSync(dest, sanitizeClaudeJson(hostClaudeJson), { mode: 0o600 });
    } catch {
      // skip if unreadable
    }
  }
}

function buildEmptyConfig(profileName: string): ProfileConfigInput['config'] {
  return { path: join(getProfileDir(profileName), 'config'), source: 'local' };
}

async function writeProfile(
  profileName: string,
  totalSteps: number,
  opts: {
    auth: ProfileConfigInput['auth'];
    config: ProfileConfigInput['config'];
    createConfigDir?: boolean;
    image: NonNullable<ProfileConfigInput['image']>;
    isolation?: boolean;
    network: NonNullable<ProfileConfigInput['network']>;
    ssh: NonNullable<ProfileConfigInput['ssh']>;
    state: 'ephemeral' | 'persistent';
  },
): Promise<boolean> {
  const profileDir = getProfileDir(profileName);

  console.log();
  const ok = await confirm({
    default: true,
    message: `[${totalSteps}/${totalSteps}] Write profile '${profileName}' to ${profileDir}?`,
  });
  if (!ok) {
    console.log('Aborted.');
    return false;
  }

  ensureCcpodDirs();
  mkdirSync(profileDir, { recursive: true });
  if (opts.createConfigDir && opts.config?.path) {
    mkdirSync(opts.config.path, { recursive: true });
  }

  const profile: ProfileConfigInput = {
    auth: opts.auth,
    claudeArgs: [],
    config: opts.config,
    env: [],
    image: opts.image,
    init: [],
    isolation: opts.isolation ?? false,
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
  return true;
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

  s.push(
    '# Optional human-readable description shown in `ccpod profile list`.',
  );
  s.push(`description: ${profile.description ? q(profile.description) : '""'}`);
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
    s.push(`  path: ${q(profile.config.path)}`);
  }
  if (profile.config?.repo) {
    s.push(`  repo: ${q(profile.config.repo)}`);
  }
  if (profile.config?.ref) {
    s.push(`  ref: ${q(profile.config.ref)}`);
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
  s.push(`  use: ${q(profile.image?.use ?? OFFICIAL_IMAGE)}`);
  if (profile.image?.dockerfile) {
    s.push(`  dockerfile: ${q(profile.image.dockerfile)}`);
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
