import { homedir } from 'node:os';

const GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

export type InstallSource =
  | { type: 'git'; url: string }
  | { type: 'url'; url: string }
  | { type: 'file'; path: string }
  | { type: 'base64'; data: string };

export function detectSource(input: string): InstallSource {
  if (
    /^https?:\/\/.+\.git$/.test(input) ||
    GIT_HOSTS.some((h) => input.includes(h))
  ) {
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
  return { data: input, type: 'base64' };
}

export async function fetchProfileYaml(
  _source: InstallSource,
): Promise<string> {
  // implemented in Task 3
  throw new Error('not implemented');
}
