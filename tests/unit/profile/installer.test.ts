import { describe, expect, it } from 'bun:test';
import { detectSource } from '../../../src/profile/installer.ts';

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
});
