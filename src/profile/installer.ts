import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';

const GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

export type InstallSource =
  | { type: 'git'; url: string }
  | { type: 'url'; url: string }
  | { type: 'file'; path: string }
  | { type: 'base64'; data: string };

function isGitHost(input: string): boolean {
  try {
    return GIT_HOSTS.includes(new URL(input).hostname);
  } catch {
    return false;
  }
}

export function detectSource(input: string): InstallSource {
  if (/^https?:\/\/.+\.git$/.test(input) || isGitHost(input)) {
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
