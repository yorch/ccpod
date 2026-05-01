import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncGitConfig } from "../../../src/profile/git-sync.ts";
import { writeSyncLock } from "../../../src/profile/lock.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {}
  }
  cleanup.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccpod-git-test-"));
  cleanup.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr?.toString()}`);
  }
}

function makeLocalRepo(): { repoDir: string; ref: string } {
  const repoDir = makeTempDir();
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "test@test.com"], repoDir);
  git(["config", "user.name", "Test"], repoDir);
  git(["config", "commit.gpgsign", "false"], repoDir);
  git(["config", "tag.gpgsign", "false"], repoDir);
  writeFileSync(join(repoDir, "config.txt"), "initial content");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);
  return { ref: "main", repoDir };
}

describe("syncGitConfig", () => {
  it("clones repo when configDir does not exist", async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();

    await syncGitConfig(profileDir, repoDir, ref, "always");

    const configDir = join(profileDir, "config");
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, "config.txt"))).toBe(true);
    expect(readFileSync(join(configDir, "config.txt"), "utf8")).toBe(
      "initial content",
    );
  });

  it("writes sync lock after cloning", async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();

    await syncGitConfig(profileDir, repoDir, ref, "always");

    expect(existsSync(join(profileDir, ".ccpod-sync-lock"))).toBe(true);
  });

  it("skips fetch when strategy=daily and synced today", async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    const configDir = join(profileDir, "config");

    await syncGitConfig(profileDir, repoDir, ref, "always");

    // Add a commit to the remote
    writeFileSync(join(repoDir, "new-file.txt"), "new content");
    git(["add", "."], repoDir);
    git(["commit", "-m", "update"], repoDir);

    // daily strategy with today's lock → should skip
    await syncGitConfig(profileDir, repoDir, ref, "daily");

    expect(existsSync(join(configDir, "new-file.txt"))).toBe(false);
  });

  it("fetches and resets when strategy=always", async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    const configDir = join(profileDir, "config");

    await syncGitConfig(profileDir, repoDir, ref, "always");

    // Add a commit to the remote
    writeFileSync(join(repoDir, "update.txt"), "updated content");
    git(["add", "."], repoDir);
    git(["commit", "-m", "update"], repoDir);

    await syncGitConfig(profileDir, repoDir, ref, "always");

    expect(existsSync(join(configDir, "update.txt"))).toBe(true);
    expect(readFileSync(join(configDir, "update.txt"), "utf8")).toBe(
      "updated content",
    );
  });

  it("skips when strategy=pin regardless of lock state", async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    const configDir = join(profileDir, "config");

    await syncGitConfig(profileDir, repoDir, ref, "always");

    // Add a commit to the remote
    writeFileSync(join(repoDir, "pinned.txt"), "pinned");
    git(["add", "."], repoDir);
    git(["commit", "-m", "update"], repoDir);

    // pin strategy always skips — lock state irrelevant
    writeSyncLock(profileDir);
    await syncGitConfig(profileDir, repoDir, ref, "pin");

    expect(existsSync(join(configDir, "pinned.txt"))).toBe(false);
  });

  it("writes sync lock after a successful fetch", async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();

    await syncGitConfig(profileDir, repoDir, ref, "always");

    // Backdate lock to yesterday to force daily sync
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    writeFileSync(join(profileDir, ".ccpod-sync-lock"), String(yesterday));

    const beforeMs = Date.now();
    await syncGitConfig(profileDir, repoDir, ref, "daily");

    const lockMs = Number(
      readFileSync(join(profileDir, ".ccpod-sync-lock"), "utf8"),
    );
    expect(lockMs).toBeGreaterThanOrEqual(beforeMs);
  });
});
