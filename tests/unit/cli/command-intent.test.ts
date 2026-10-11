import { describe, expect, it } from 'bun:test';
import {
  firstCommandToken,
  isDoctorCommandIntent,
} from '../../../src/cli/command-intent.ts';

describe('CLI command intent', () => {
  it('recognizes doctor after leading boolean flags', () => {
    expect(isDoctorCommandIntent(['--json', 'doctor'])).toBe(true);
    expect(isDoctorCommandIntent(['--help', 'doctor'])).toBe(true);
    expect(isDoctorCommandIntent(['--json', '--help', 'doctor'])).toBe(true);
  });

  it('keeps non-doctor commands eligible for update checks', () => {
    expect(isDoctorCommandIntent(['ps', '--json'])).toBe(false);
    expect(isDoctorCommandIntent(['--help', 'logs'])).toBe(false);
  });

  it('does not treat values after an option terminator as a command', () => {
    expect(firstCommandToken(['--json', '--', 'doctor'])).toBeUndefined();
  });
});
