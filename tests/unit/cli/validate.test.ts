import { describe, expect, it, spyOn } from 'bun:test';
import { validateProfileArg } from '../../../src/cli/validate.ts';

describe('validateProfileArg', () => {
  it('does nothing when name is undefined', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    try {
      expect(() => validateProfileArg(undefined)).not.toThrow();
      expect(exitSpy.mock.calls.length).toBe(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('accepts valid profile names', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    try {
      expect(() => validateProfileArg('default')).not.toThrow();
      expect(() => validateProfileArg('my-profile_1')).not.toThrow();
      expect(exitSpy.mock.calls.length).toBe(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('exits on path traversal', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => validateProfileArg('../etc')).toThrow('process.exit');
      expect(errorSpy.mock.calls[0][0] as string).toMatch(/Invalid profile/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('exits on shell metacharacters', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => validateProfileArg('foo;rm')).toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('exits on name exceeding 64 chars', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => validateProfileArg('a'.repeat(65))).toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('exits on empty string (not treated as undefined)', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => validateProfileArg('')).toThrow('process.exit');
      expect(errorSpy.mock.calls[0][0] as string).toMatch(/Invalid profile/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
