import { describe, expect, it } from 'bun:test';
import { rejectExtraPositionals, repeatedFlag } from '../../../src/cli/args.ts';

describe('repeatedFlag', () => {
  it('collects every value in order, in both spellings', () => {
    expect(
      repeatedFlag(['--env', 'A=1', '--profile', 'x', '--env=B=2'], 'env'),
    ).toEqual(['A=1', 'B=2']);
  });

  it('stops at -- so child-command flags are not consumed', () => {
    expect(repeatedFlag(['--env', 'A=1', '--', '--env', 'B=2'], 'env')).toEqual(
      ['A=1'],
    );
  });

  it('ignores a trailing flag with no value and unrelated flags', () => {
    expect(repeatedFlag(['--environment', 'x', '--env'], 'env')).toEqual([]);
  });
});

describe('rejectExtraPositionals', () => {
  it('is a no-op without extras', () => {
    expect(() => rejectExtraPositionals({ _: [] })).not.toThrow();
    expect(() => rejectExtraPositionals({})).not.toThrow();
  });
});
