import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("loadGlobalConfig()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dir, `__tmp_global_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.CCPOD_TEST_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    delete process.env.CCPOD_TEST_DIR;
  });

  it("returns defaults when no config file exists", async () => {
    const { loadGlobalConfig } = await import("../../../src/global/config.ts");
    const cfg = loadGlobalConfig();
    expect(cfg.autoCheckUpdates).toBe(true);
  });

  it("round-trips autoCheckUpdates: false", async () => {
    const { loadGlobalConfig, saveGlobalConfig } = await import(
      "../../../src/global/config.ts"
    );
    saveGlobalConfig({ autoCheckUpdates: false });
    const cfg = loadGlobalConfig();
    expect(cfg.autoCheckUpdates).toBe(false);
  });

  it("returns defaults when config file is malformed", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(tmpDir, "config.yml"), ":::invalid yaml:::", "utf8");
    const { loadGlobalConfig } = await import("../../../src/global/config.ts");
    const cfg = loadGlobalConfig();
    expect(cfg.autoCheckUpdates).toBe(true);
  });
});
