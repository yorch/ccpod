import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  getLastSync,
  shouldSync,
  writeSyncLock,
} from "../../../src/profile/lock.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/ccpod-test-`);
});

describe("shouldSync", () => {
  it("always returns true for strategy=always", () => {
    expect(shouldSync(tmpDir, "always")).toBe(true);
  });

  it("always returns false for strategy=pin", () => {
    expect(shouldSync(tmpDir, "pin")).toBe(false);
  });

  it("returns true when no lock file exists for strategy=daily", () => {
    expect(shouldSync(tmpDir, "daily")).toBe(true);
  });

  it("returns false when synced today for strategy=daily", () => {
    writeSyncLock(tmpDir);
    expect(shouldSync(tmpDir, "daily")).toBe(false);
  });
});

describe("getLastSync", () => {
  it("returns null when no lock file", () => {
    expect(getLastSync(tmpDir)).toBeNull();
  });

  it("returns a Date after writing lock", () => {
    writeSyncLock(tmpDir);
    const result = getLastSync(tmpDir);
    expect(result).toBeInstanceOf(Date);
  });
});
