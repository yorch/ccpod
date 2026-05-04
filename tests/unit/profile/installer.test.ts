import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectSource,
  fetchProfileYaml,
} from '../../../src/profile/installer.ts';

describe('detectSource', () => {
  it('detects github.com URL as git', () => {
    const result = detectSource('https://github.com/user/my-profile');
    expect(result).toEqual({
      type: 'git',
      url: 'https://github.com/user/my-profile',
    });
  });

  it('detects gitlab.com URL as git', () => {
    const result = detectSource('https://gitlab.com/org/profile');
    expect(result).toEqual({
      type: 'git',
      url: 'https://gitlab.com/org/profile',
    });
  });

  it('detects bitbucket.org URL as git', () => {
    const result = detectSource('https://bitbucket.org/user/profile');
    expect(result).toEqual({
      type: 'git',
      url: 'https://bitbucket.org/user/profile',
    });
  });

  it('detects .git suffix URL as git', () => {
    const result = detectSource('https://example.com/repo.git');
    expect(result).toEqual({
      type: 'git',
      url: 'https://example.com/repo.git',
    });
  });

  it('detects plain https URL as url', () => {
    const result = detectSource('https://example.com/profile.yml');
    expect(result).toEqual({
      type: 'url',
      url: 'https://example.com/profile.yml',
    });
  });

  it('detects http URL as url', () => {
    const result = detectSource('http://example.com/raw/profile.yml');
    expect(result).toEqual({
      type: 'url',
      url: 'http://example.com/raw/profile.yml',
    });
  });

  it('detects absolute path as file', () => {
    const result = detectSource('/home/user/.ccpod/profiles/test/profile.yml');
    expect(result).toEqual({
      path: '/home/user/.ccpod/profiles/test/profile.yml',
      type: 'file',
    });
  });

  it('detects relative path as file', () => {
    const result = detectSource('./my-profile.yml');
    expect(result).toEqual({ path: './my-profile.yml', type: 'file' });
  });

  it('expands ~ in file paths', () => {
    const result = detectSource('~/profiles/test.yml');
    expect(result.type).toBe('file');
    expect((result as { type: 'file'; path: string }).path).not.toContain('~');
  });

  it('treats unknown input as base64', () => {
    const encoded = Buffer.from('name: test\n').toString('base64');
    const result = detectSource(encoded);
    expect(result).toEqual({ data: encoded, type: 'base64' });
  });

  it('does not classify notgithub.com as git', () => {
    const result = detectSource('https://notgithub.com/user/repo');
    expect(result.type).toBe('url');
  });

  it('detects git@ SSH URL as git', () => {
    const src = detectSource('git@github.com:user/repo.git');
    expect(src).toEqual({ type: 'git', url: 'git@github.com:user/repo.git' });
  });

  it('detects git:// URL as git', () => {
    const src = detectSource('git://github.com/user/repo.git');
    expect(src).toEqual({ type: 'git', url: 'git://github.com/user/repo.git' });
  });
});

describe('fetchProfileYaml - file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccpod-fetch-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('reads YAML from an absolute file path', async () => {
    const filePath = join(tmpDir, 'profile.yml');
    writeFileSync(filePath, 'name: test\n');
    const result = await fetchProfileYaml({ path: filePath, type: 'file' });
    expect(result).toBe('name: test\n');
  });

  it('throws when file does not exist', async () => {
    await expect(
      fetchProfileYaml({ path: join(tmpDir, 'missing.yml'), type: 'file' }),
    ).rejects.toThrow('File not found:');
  });
});

describe('fetchProfileYaml - base64', () => {
  it('decodes base64 string to YAML', async () => {
    const yaml = 'name: test\nstate: ephemeral\n';
    const encoded = Buffer.from(yaml).toString('base64');
    const result = await fetchProfileYaml({ data: encoded, type: 'base64' });
    expect(result).toBe(yaml);
  });

  it('round-trips: encode then decode returns original', async () => {
    const yaml =
      'name: myprofile\nstate: persistent\nimage:\n  use: ghcr.io/user/image:latest\n';
    const encoded = Buffer.from(yaml).toString('base64');
    const result = await fetchProfileYaml({ data: encoded, type: 'base64' });
    expect(result).toBe(yaml);
  });
  // Note: Node's Buffer.from never throws on invalid base64 — it silently decodes what it can.
  // Invalid content is caught downstream by the YAML parser and Zod schema in the install command.
});

describe('fetchProfileYaml - url', () => {
  it('fetches and returns YAML from HTTP URL', async () => {
    const yaml = 'name: remote\nstate: ephemeral\n';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: true,
      text: async () => yaml,
    })) as typeof fetch;

    try {
      const result = await fetchProfileYaml({
        type: 'url',
        url: 'https://example.com/profile.yml',
      });
      expect(result).toBe(yaml);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on non-200 HTTP response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
    })) as typeof fetch;

    try {
      await expect(
        fetchProfileYaml({
          type: 'url',
          url: 'https://example.com/missing.yml',
        }),
      ).rejects.toThrow('HTTP 404');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
