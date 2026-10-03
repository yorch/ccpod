import { describe, expect, it } from 'bun:test';
import {
  leadingPositional,
  rejectExtraPositionals,
  repeatedFlag,
  splitPassthrough,
} from '../../../src/cli/args.ts';

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

describe('splitPassthrough / leadingPositional (ccpod run -- <flags>)', () => {
  const VALUE_FLAGS = ['--env', '--file', '--profile', '--resume'];
  const promptOf = (raw: string[]) =>
    leadingPositional(splitPassthrough(raw).before, VALUE_FLAGS);

  it('does not treat the first token after -- as a prompt', () => {
    expect(promptOf(['--', '--verbose'])).toBeUndefined();
    expect(promptOf(['--', '--model', 'opus'])).toBeUndefined();
    expect(splitPassthrough(['--', '--model', 'opus']).passthrough).toEqual([
      '--model',
      'opus',
    ]);
  });

  it('still finds an inline prompt before --', () => {
    expect(promptOf(['fix it', '--', '--verbose'])).toBe('fix it');
    expect(promptOf(['--rebuild', 'fix it'])).toBe('fix it');
  });

  it('skips the values of value-taking flags', () => {
    expect(promptOf(['--resume', 'abc', '--profile', 'work'])).toBeUndefined();
    expect(promptOf(['--resume', 'abc', 'do it'])).toBe('do it');
    // a flag value that merely equals a later token is not a prompt
    expect(promptOf(['--resume', 'x', '--', 'x'])).toBeUndefined();
    expect(promptOf(['--resume=abc'])).toBeUndefined();
  });

  it('returns everything after the first -- verbatim, including a second --', () => {
    expect(splitPassthrough(['a', '--', 'b', '--', 'c'])).toEqual({
      before: ['a'],
      passthrough: ['b', '--', 'c'],
    });
  });

  it('has no passthrough without a separator', () => {
    expect(splitPassthrough(['x', '--y'])).toEqual({
      before: ['x', '--y'],
      passthrough: [],
    });
  });
});
