import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import {
  findProjectConfig,
  loadProfileConfig,
  loadProjectConfig,
} from "../../../src/config/loader.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/ccpod-test-`);
});
afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

describe("loadProfileConfig", () => {
  it("parses a valid profile.yml", () => {
    writeFileSync(
      join(tmpDir, "profile.yml"),
      yamlStringify({
        config: { path: "/tmp/cfg", source: "local" },
        name: "myprod",
      }),
    );
    const profile = loadProfileConfig(tmpDir);
    expect(profile.name).toBe("myprod");
    expect(profile.config.source).toBe("local");
    expect(profile.state).toBe("ephemeral"); // default applied
    expect(profile.ssh.agentForward).toBe(true); // default applied
  });

  it("throws when profile.yml is missing", () => {
    expect(() => loadProfileConfig(tmpDir)).toThrow(/Profile not found/);
  });
});

describe("findProjectConfig", () => {
  it("finds .ccpod.yml in the start directory", () => {
    writeFileSync(join(tmpDir, ".ccpod.yml"), "merge: deep");
    expect(findProjectConfig(tmpDir)).toBe(join(tmpDir, ".ccpod.yml"));
  });

  it("walks up to find .ccpod.yml in a parent directory", () => {
    const child = join(tmpDir, "sub", "deep");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(tmpDir, ".ccpod.yml"), "merge: deep");
    expect(findProjectConfig(child)).toBe(join(tmpDir, ".ccpod.yml"));
  });

  it("returns null when no .ccpod.yml found", () => {
    const child = join(tmpDir, "sub");
    mkdirSync(child);
    expect(findProjectConfig(child)).toBeNull();
  });
});

describe("loadProjectConfig", () => {
  it("returns null when no .ccpod.yml found", () => {
    expect(loadProjectConfig(tmpDir)).toBeNull();
  });

  it("parses a valid .ccpod.yml", () => {
    writeFileSync(
      join(tmpDir, ".ccpod.yml"),
      yamlStringify({ merge: "override", profile: "custom" }),
    );
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg).not.toBeNull();
    expect(cfg?.profile).toBe("custom");
    expect(cfg?.merge).toBe("override");
  });

  it("applies defaults for omitted fields", () => {
    writeFileSync(join(tmpDir, ".ccpod.yml"), "{}");
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg?.merge).toBe("deep");
  });
});
