import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMergedConfig } from "../../../src/config/writer.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup) rmSync(dir, { force: true, recursive: true });
  cleanup.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccpod-writer-test-"));
  cleanup.push(dir);
  return dir;
}

function run(profileDir: string, claudeMd: string, settings: object): string {
  const out = writeMergedConfig(profileDir, claudeMd, settings);
  cleanup.push(out);
  return out;
}

describe("writeMergedConfig", () => {
  it("writes CLAUDE.md with correct content", () => {
    const out = run(makeTempDir(), "# Hello\nWorld", {});
    expect(readFileSync(join(out, "CLAUDE.md"), "utf8")).toBe("# Hello\nWorld");
  });

  it("writes settings.json with correct content", () => {
    const out = run(makeTempDir(), "", { model: "opus", theme: "dark" });
    const settings = JSON.parse(
      readFileSync(join(out, "settings.json"), "utf8"),
    );
    expect(settings.theme).toBe("dark");
    expect(settings.model).toBe("opus");
  });

  it("returns same path for identical inputs (cache hit)", () => {
    const profileDir = makeTempDir();
    const first = run(profileDir, "same content", { key: "val" });
    const second = writeMergedConfig(profileDir, "same content", {
      key: "val",
    });
    expect(first).toBe(second);
  });

  it("returns different path when claudeMd changes", () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, "content-a", {});
    const b = run(profileDir, "content-b", {});
    expect(a).not.toBe(b);
  });

  it("returns different path when settings change", () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, "same", { x: 1 });
    const b = run(profileDir, "same", { x: 2 });
    expect(a).not.toBe(b);
  });

  it("copies regular files from profile config dir", () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, "hooks.json"), '{"hooks":[]}');
    const out = run(profileDir, "cp-test", { cp: true });
    expect(readFileSync(join(out, "hooks.json"), "utf8")).toBe('{"hooks":[]}');
  });

  it("skips symlinks from profile config dir", () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, "real.txt"), "real");
    symlinkSync(join(profileDir, "real.txt"), join(profileDir, "link.txt"));
    const out = run(profileDir, "symlink-test", { sym: true });
    expect(existsSync(join(out, "link.txt"))).toBe(false);
    expect(existsSync(join(out, "real.txt"))).toBe(true);
  });

  it("generated CLAUDE.md overrides any CLAUDE.md in profile dir", () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, "CLAUDE.md"), "profile content");
    const out = run(profileDir, "generated content", { override: true });
    expect(readFileSync(join(out, "CLAUDE.md"), "utf8")).toBe(
      "generated content",
    );
  });

  it("generated settings.json overrides any settings.json in profile dir", () => {
    const profileDir = makeTempDir();
    writeFileSync(join(profileDir, "settings.json"), '{"old":true}');
    const out = run(profileDir, "", { new: true });
    const settings = JSON.parse(
      readFileSync(join(out, "settings.json"), "utf8"),
    );
    expect(settings.new).toBe(true);
    expect(settings.old).toBeUndefined();
  });

  it("works when profileConfigDir does not exist", () => {
    const out = run("/nonexistent/path/abc123", "no profile dir", {});
    expect(readFileSync(join(out, "CLAUDE.md"), "utf8")).toBe("no profile dir");
  });

  it("returns different path when a new file is added to profile dir", () => {
    const profileDir = makeTempDir();
    const a = run(profileDir, "stale-test", { v: 1 });
    // Add a new file to profileDir after first write
    writeFileSync(join(profileDir, "new-hook.json"), '{"new":true}');
    const b = run(profileDir, "stale-test", { v: 1 });
    expect(a).not.toBe(b);
    expect(existsSync(join(b, "new-hook.json"))).toBe(true);
  });

  it("outputs CLAUDE.md and settings.json with restricted permissions", () => {
    const out = run(makeTempDir(), "perm-test", { key: "val" });
    const claudeMdMode = statSync(join(out, "CLAUDE.md")).mode & 0o777;
    const settingsMode = statSync(join(out, "settings.json")).mode & 0o777;
    expect(claudeMdMode).toBe(0o600);
    expect(settingsMode).toBe(0o600);
  });
});
