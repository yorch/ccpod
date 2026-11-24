import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { OFFICIAL_IMAGE } from '../constants.ts';

const GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
// Hosts that serve raw file content rather than clonable repositories — must
// be classified as `url`, not `git`, even though they live under "known git
// providers".
const RAW_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com'];

interface RiskyProfileFields {
  allowProjectEnvForward: string[];
  allowProjectHostMounts: boolean;
  allowProjectInit: boolean;
  allowProjectServices: boolean;
  auth?: { keyFile?: string };
  claudeArgs?: string[];
  config: { path?: string; repo?: string };
  env: string[];
  image?: { dockerfile?: string; use: string };
  init: string[];
  network: { allow?: string[]; policy: string };
  permissions?: string;
  plugins?: string[];
  ports?: { list?: string[] };
  services: Record<string, { image: string }>;
  ssh: { mountSshDir: boolean };
}

/**
 * Human-readable list of the capabilities a profile grants that deserve a
 * look before installing (init scripts, extra containers, host mounts, open
 * network, trust of project configs). Empty when nothing notable is requested.
 */
export function summarizeProfileRisks(profile: RiskyProfileFields): string[] {
  const out: string[] = [];
  if (profile.init.length > 0) {
    out.push(`runs ${profile.init.length} init command(s) on every start:`);
    for (const cmd of profile.init) {
      out.push(`    $ ${cmd}`);
    }
  }
  for (const [name, svc] of Object.entries(profile.services)) {
    out.push(`starts sidecar '${name}' from image ${svc.image}`);
  }
  if (profile.config.repo) {
    out.push(`pulls its Claude config from ${profile.config.repo}`);
  }
  if (profile.ssh.mountSshDir) {
    out.push('mounts your ~/.ssh directory into the container');
  }
  if (profile.network.policy === 'full') {
    out.push('allows unrestricted network egress (network.policy: full)');
  }
  if (profile.allowProjectInit) {
    out.push('lets any project run init commands (allowProjectInit)');
  }
  if (profile.allowProjectHostMounts) {
    out.push('lets any project mount host paths (allowProjectHostMounts)');
  }
  if (profile.allowProjectServices) {
    out.push(
      'lets any project start sidecar containers (allowProjectServices)',
    );
  }
  if (profile.allowProjectEnvForward.length > 0) {
    out.push(
      `lets projects forward host env vars: ${profile.allowProjectEnvForward.join(', ')}`,
    );
  }
  if (profile.image && profile.image.use !== OFFICIAL_IMAGE) {
    out.push(`runs a non-default image: ${profile.image.use}`);
  }
  if (profile.image?.dockerfile) {
    out.push(`builds a local Dockerfile: ${profile.image.dockerfile}`);
  }
  if (profile.claudeArgs && profile.claudeArgs.length > 0) {
    out.push(`passes extra claude args: ${profile.claudeArgs.join(' ')}`);
  }
  if (profile.permissions === 'permissive') {
    out.push('uses the permissive permissions preset');
  }
  if (profile.plugins && profile.plugins.length > 0) {
    out.push(`installs plugins: ${profile.plugins.join(', ')}`);
  }
  if (profile.ports?.list && profile.ports.list.length > 0) {
    out.push(`publishes ports: ${profile.ports.list.join(', ')}`);
  }
  if (profile.config.path) {
    out.push(`reads its Claude config from host path ${profile.config.path}`);
  }
  if (
    profile.network.policy === 'restricted' &&
    profile.network.allow &&
    profile.network.allow.length > 0
  ) {
    out.push(
      `allows network egress to: ${profile.network.allow.join(', ')} (network.allow)`,
    );
  }
  if (profile.auth?.keyFile) {
    out.push(`reads its API key from ${profile.auth.keyFile}`);
  }
  const literalEnv = profile.env.filter(
    (e) => e.includes('=') && !/\$\{/.test(e),
  );
  if (literalEnv.length > 0) {
    out.push(
      `sets ${literalEnv.length} literal env var(s): ${literalEnv.map((e) => e.slice(0, e.indexOf('='))).join(', ')}`,
    );
  }
  const interpolated = profile.env.filter((e) => /\$\{/.test(e));
  if (interpolated.length > 0) {
    out.push(`forwards host env via interpolation: ${interpolated.join(', ')}`);
  }
  return out;
}

type InstallSource =
  | { type: 'git'; url: string }
  | { type: 'url'; url: string }
  | { type: 'file'; path: string }
  | { type: 'base64'; data: string };

function isGitUrl(input: string): boolean {
  // `.git` suffix is unambiguous regardless of host.
  if (/^https?:\/\/.+\.git$/.test(input)) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (RAW_HOSTS.includes(url.hostname)) {
    return false;
  }
  // `github.com/<owner>/<repo>/raw/...` is a raw file URL even though it lives
  // under github.com. `/blob/...` is similar (it points at the rendered file
  // view, not a clone target).
  if (
    url.hostname === 'github.com' &&
    /^\/[^/]+\/[^/]+\/(raw|blob)\//.test(url.pathname)
  ) {
    return false;
  }
  return GIT_HOSTS.includes(url.hostname);
}

export function describeSource(source: InstallSource): string {
  switch (source.type) {
    case 'git':
    case 'url':
      return source.url;
    case 'file':
      return source.path;
    case 'base64':
      return '<inline base64>';
  }
}

export function detectSource(input: string): InstallSource {
  // A leading '-' would be parsed as an option by `git clone` (option injection).
  if (input.startsWith('-')) {
    throw new Error(
      `Invalid profile source '${input}': must not start with '-'`,
    );
  }
  if (isGitUrl(input)) {
    return { type: 'git', url: input };
  }
  if (/^https?:\/\//.test(input)) {
    return { type: 'url', url: input };
  }
  if (
    input.startsWith('/') ||
    input.startsWith('./') ||
    input.startsWith('~/') ||
    input === '~'
  ) {
    return { path: input.replace(/^~(?=\/|$)/, homedir()), type: 'file' };
  }
  // Detect SSH, git-protocol, and scp-style URLs before treating as base64.
  // scp-style: user@host:path (no slashes before the colon) — same pattern
  // accepted by gitRepoSchema in config/schema.ts.
  if (/^(git@|git:\/\/|ssh:\/\/)/.test(input)) {
    return { type: 'git', url: input };
  }
  if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+:/.test(input)) {
    return { type: 'git', url: input };
  }
  return { data: input, type: 'base64' };
}

export async function fetchProfileYaml(source: InstallSource): Promise<string> {
  switch (source.type) {
    case 'git': {
      const tmpBase = mkdtempSync(join(tmpdir(), 'ccpod-install-'));
      const tmpDir = join(tmpBase, 'repo');
      try {
        await simpleGit().clone(source.url, tmpDir, ['--depth', '1']);
        const profilePath = join(tmpDir, 'profile.yml');
        if (!existsSync(profilePath)) {
          throw new Error(`No profile.yml found at root of ${source.url}`);
        }
        return readFileSync(profilePath, 'utf8');
      } finally {
        rmSync(tmpBase, { force: true, recursive: true });
      }
    }
    case 'url': {
      const res = await fetch(source.url);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${source.url}: HTTP ${res.status}`);
      }
      return res.text();
    }
    case 'file': {
      if (!existsSync(source.path)) {
        throw new Error(`File not found: ${source.path}`);
      }
      return readFileSync(source.path, 'utf8');
    }
    case 'base64': {
      return Buffer.from(source.data, 'base64').toString('utf8');
    }
  }
}
