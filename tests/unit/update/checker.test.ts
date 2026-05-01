import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNewer } from "../../../src/update/checker.ts";

// isNewer is pure — no I/O needed
describe("isNewer()", () => {
  it("returns false when versions are equal", () => {
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });

  it("detects patch bump", () => {
    expect(isNewer("v0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.1")).toBe(false);
  });

  it("detects minor bump", () => {
    expect(isNewer("v0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("v0.1.9", "0.2.0")).toBe(false);
  });

  it("detects major bump", () => {
    expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("v0.9.9", "1.0.0")).toBe(false);
  });

  it("handles missing v prefix on either side", () => {
    expect(isNewer("1.0.0", "v0.9.9")).toBe(true);
    expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
  });
});

// checkForUpdate I/O behaviour via CCPOD_TEST_DIR
describe("checkForUpdate() — cache behaviour", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dir, `__tmp_checker_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.CCPOD_TEST_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    delete process.env.CCPOD_TEST_DIR;
  });

  it("returns null when no cache exists", async () => {
    const { checkForUpdate } = await import("../../../src/update/checker.ts");
    expect(checkForUpdate("0.1.0")).toBeNull();
  });

  it("returns null when cached version equals current", async () => {
    const { cachePath, writeCache, checkForUpdate } = await import(
      "../../../src/update/checker.ts"
    );
    writeCache("v0.1.0");
    // Make the checkedAt appear recent
    expect(checkForUpdate("0.1.0")).toBeNull();
  });

  it("returns latest when cached version is newer", async () => {
    const { writeCache, checkForUpdate } = await import(
      "../../../src/update/checker.ts"
    );
    writeCache("v0.2.0");
    expect(checkForUpdate("0.1.0")).toBe("v0.2.0");
  });

  it("returns null when cache is older than current", async () => {
    const { writeCache, checkForUpdate } = await import(
      "../../../src/update/checker.ts"
    );
    writeCache("v0.0.9");
    expect(checkForUpdate("0.1.0")).toBeNull();
  });
});
