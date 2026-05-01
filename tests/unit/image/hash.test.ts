import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDockerfileHash } from '../../../src/image/hash.ts';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ccpod-hash-test-'));
});

afterEach(() => {
  rmSync(testDir, { force: true, recursive: true });
});

describe('computeDockerfileHash', () => {
  it('hashes file contents when relative path resolves to existing file', () => {
    const content = 'FROM node:24\nRUN echo hello';
    writeFileSync(join(testDir, 'Dockerfile'), content);

    const hash = computeDockerfileHash('Dockerfile', testDir);

    const expected = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 16);
    expect(hash).toBe(expected);
  });

  it('hashes file contents when absolute path points to existing file', () => {
    const absPath = join(testDir, 'Dockerfile');
    const content = 'FROM node:24-slim';
    writeFileSync(absPath, content);

    const hash = computeDockerfileHash(absPath, '/irrelevant');

    const expected = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 16);
    expect(hash).toBe(expected);
  });

  it('falls back to resolved absolute path hash when file does not exist', () => {
    const hash = computeDockerfileHash('Dockerfile', testDir);

    const expected = createHash('sha256')
      .update(join(testDir, 'Dockerfile'))
      .digest('hex')
      .slice(0, 16);
    expect(hash).toBe(expected);
  });

  it('different cwd with same relative name produces different fallback hash', () => {
    const hash1 = computeDockerfileHash('Dockerfile', '/project/a');
    const hash2 = computeDockerfileHash('Dockerfile', '/project/b');
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash when file contents change', () => {
    const path = join(testDir, 'Dockerfile');
    writeFileSync(path, 'FROM node:20');
    const hash1 = computeDockerfileHash('Dockerfile', testDir);

    writeFileSync(path, 'FROM node:24');
    const hash2 = computeDockerfileHash('Dockerfile', testDir);

    expect(hash1).not.toBe(hash2);
  });

  it('returns 16-character hex string', () => {
    writeFileSync(join(testDir, 'Dockerfile'), 'FROM scratch');
    const hash = computeDockerfileHash('Dockerfile', testDir);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not join cwd when path is absolute', () => {
    const absPath = join(testDir, 'sub', 'Dockerfile');
    mkdirSync(join(testDir, 'sub'), { recursive: true });
    writeFileSync(absPath, 'FROM alpine');

    const hash = computeDockerfileHash(absPath, '/some/other/dir');

    const expected = createHash('sha256')
      .update('FROM alpine')
      .digest('hex')
      .slice(0, 16);
    expect(hash).toBe(expected);
  });
});
