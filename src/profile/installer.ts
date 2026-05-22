import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';

const GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
// Hosts that serve raw file content rather than clonable repositories — must
// be classified as `url`, not `git`, even though they live under "known git
// providers".
const RAW_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com'];

export type InstallSource =
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
  // Detect SSH and git-protocol URLs before treating as base64
  if (/^(git@|git:\/\/|ssh:\/\/)/.test(input)) {
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
