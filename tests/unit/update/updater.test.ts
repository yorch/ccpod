import { describe, expect, it } from 'bun:test';
import { parseChecksums } from '../../../src/update/updater.ts';

describe('parseChecksums', () => {
  it('parses sha256sum-style lines', () => {
    const txt = [
      `${'a'.repeat(64)}  ccpod-linux-x64`,
      `${'b'.repeat(64)}  ccpod-darwin-arm64`,
    ].join('\n');
    const map = parseChecksums(txt);
    expect(map.get('ccpod-linux-x64')).toBe('a'.repeat(64));
    expect(map.get('ccpod-darwin-arm64')).toBe('b'.repeat(64));
  });

  it('accepts binary-mode asterisk prefix', () => {
    const txt = `${'c'.repeat(64)} *ccpod-linux-arm64`;
    expect(parseChecksums(txt).get('ccpod-linux-arm64')).toBe('c'.repeat(64));
  });

  it('ignores blank lines and comments', () => {
    const txt = ['# header', '', `${'d'.repeat(64)}  ccpod-linux-x64`].join(
      '\n',
    );
    expect(parseChecksums(txt).size).toBe(1);
  });

  it('skips malformed lines', () => {
    const txt = ['short  ccpod-linux-x64', `${'e'.repeat(64)}  good`].join(
      '\n',
    );
    const map = parseChecksums(txt);
    expect(map.has('ccpod-linux-x64')).toBe(false);
    expect(map.get('good')).toBe('e'.repeat(64));
  });

  it('lowercases hex digests', () => {
    const txt = `${'F'.repeat(64)}  ccpod-linux-x64`;
    expect(parseChecksums(txt).get('ccpod-linux-x64')).toBe('f'.repeat(64));
  });
});
