import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportProfile } from '../../../src/profile/exporter.ts';

let testBase: string;

beforeEach(() => {
  testBase = mkdtempSync(join(tmpdir(), 'ccpod-exporter-test-'));
  process.env.CCPOD_TEST_DIR = testBase;
});

afterEach(() => {
  delete process.env.CCPOD_TEST_DIR;
  rmSync(testBase, { force: true, recursive: true });
});

function makeProfile(name: string, content: string): void {
  const dir = join(testBase, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profile.yml'), content);
}

describe('exportProfile', () => {
  it('returns base64-encoded profile.yml content', () => {
    const yaml = 'name: test\nstate: ephemeral\n';
    makeProfile('test', yaml);
    const result = exportProfile('test');
    expect(Buffer.from(result, 'base64').toString('utf8')).toBe(yaml);
  });

  it('throws when profile does not exist', () => {
    expect(() => exportProfile('missing')).toThrow(
      'Profile not found: missing',
    );
  });

  it('round-trips: exported string decodes to original bytes', () => {
    const yaml = 'name: roundtrip\nstate: persistent\n';
    makeProfile('roundtrip', yaml);
    const encoded = exportProfile('roundtrip');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(yaml);
  });
});
