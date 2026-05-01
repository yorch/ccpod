import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteProfile,
  ensureCcpodDirs,
  getCredentialsDir,
  getProfileDir,
  listProfiles,
  profileExists,
} from "../../../src/profile/manager.ts";

let testBase: string;

beforeEach(() => {
  testBase = mkdtempSync(join(tmpdir(), "ccpod-manager-test-"));
  process.env.CCPOD_TEST_DIR = testBase;
});

afterEach(() => {
  delete process.env.CCPOD_TEST_DIR;
  rmSync(testBase, { force: true, recursive: true });
});

function makeProfile(name: string): void {
  const dir = join(testBase, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.yml"), `name: ${name}\n`);
}

describe("profileExists", () => {
  it("returns false when profile dir absent", () => {
    expect(profileExists("missing")).toBe(false);
  });

  it("returns false when dir exists but profile.yml absent", () => {
    mkdirSync(join(testBase, "profiles", "empty"), { recursive: true });
    expect(profileExists("empty")).toBe(false);
  });

  it("returns true when profile.yml present", () => {
    makeProfile("myprofile");
    expect(profileExists("myprofile")).toBe(true);
  });
});

describe("listProfiles", () => {
  it("returns empty array when profiles dir absent", () => {
    expect(listProfiles()).toEqual([]);
  });

  it("returns empty array when profiles dir is empty", () => {
    mkdirSync(join(testBase, "profiles"), { recursive: true });
    expect(listProfiles()).toEqual([]);
  });

  it("filters out entries without profile.yml", () => {
    mkdirSync(join(testBase, "profiles", "no-yml"), { recursive: true });
    makeProfile("valid");
    expect(listProfiles()).toEqual(["valid"]);
  });

  it("returns all valid profile names", () => {
    makeProfile("alpha");
    makeProfile("beta");
    expect(listProfiles().sort()).toEqual(["alpha", "beta"]);
  });
});

describe("deleteProfile", () => {
  it("throws when profile does not exist", () => {
    expect(() => deleteProfile("ghost")).toThrow("Profile not found: ghost");
  });

  it("removes profile dir on success", () => {
    makeProfile("todelete");
    deleteProfile("todelete");
    expect(existsSync(join(testBase, "profiles", "todelete"))).toBe(false);
  });
});

describe("getProfileDir", () => {
  it("returns path under profiles dir", () => {
    const dir = getProfileDir("myprofile");
    expect(dir).toBe(join(testBase, "profiles", "myprofile"));
  });
});

describe("getCredentialsDir", () => {
  it("creates dir if absent and returns path", () => {
    const dir = getCredentialsDir("myprofile");
    expect(existsSync(dir)).toBe(true);
    expect(dir).toBe(join(testBase, "credentials", "myprofile"));
  });

  it("returns same path if dir already exists", () => {
    const first = getCredentialsDir("myprofile");
    const second = getCredentialsDir("myprofile");
    expect(first).toBe(second);
  });
});

describe("ensureCcpodDirs", () => {
  it("creates profiles and credentials dirs", () => {
    ensureCcpodDirs();
    expect(existsSync(join(testBase, "profiles"))).toBe(true);
    expect(existsSync(join(testBase, "credentials"))).toBe(true);
  });

  it("does not throw if dirs already exist", () => {
    ensureCcpodDirs();
    expect(() => ensureCcpodDirs()).not.toThrow();
  });
});
