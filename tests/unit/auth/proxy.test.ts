import { describe, expect, it } from 'bun:test';
import { generateSentinelApiKey } from '../../../src/auth/proxy.ts';

describe('generateSentinelApiKey', () => {
  it('produces a format-valid sentinel that looks like an API key', () => {
    const key = generateSentinelApiKey();
    expect(key).toMatch(/^sk-ant-api03-ccpod-proxy-/);
  });

  it('produces unique values on each call', () => {
    const a = generateSentinelApiKey();
    const b = generateSentinelApiKey();
    expect(a).not.toBe(b);
  });
});
