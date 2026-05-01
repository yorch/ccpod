import { existsSync } from "node:fs";
import simpleGit from "simple-git";
import type { SyncStrategy } from "../types/index.ts";
import { shouldSync, writeSyncLock } from "./lock.ts";

export async function syncGitConfig(
  profileDir: string,
  repo: string,
  ref: string,
  strategy: SyncStrategy,
): Promise<void> {
  const configDir = `${profileDir}/config`;

  if (!existsSync(configDir)) {
    const git = simpleGit();
    await git.clone(repo, configDir, ["--depth", "1", "--branch", ref]);
    writeSyncLock(profileDir);
    return;
  }

  if (!shouldSync(profileDir, strategy)) return;

  const git = simpleGit(configDir);
  await git.fetch("origin", ref);
  await git.reset(["--hard", `origin/${ref}`]);
  writeSyncLock(profileDir);
}
