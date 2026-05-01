import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { stringify as yamlStringify } from "yaml";
import type { ProfileConfigInput } from "../config/schema.ts";
import {
  ensureCcpodDirs,
  PROFILES_DIR,
  profileExists,
} from "../profile/manager.ts";
import { detectRuntime } from "../runtime/detector.ts";

export async function runWizard(profileName = "default"): Promise<void> {
  console.log(chalk.bold("\nccpod setup wizard\n"));

  // Step 1 — runtime detection
  console.log(chalk.dim("Detecting container runtime..."));
  try {
    const runtime = detectRuntime();
    console.log(
      chalk.green(`✓ [1/5] ${capitalize(runtime.name)} detected`) +
        chalk.dim(` (${runtime.socketPath})`),
    );
  } catch {
    console.log(
      chalk.yellow(
        "⚠ [1/5] No runtime detected — install Docker, OrbStack, Colima, or Podman before running containers.",
      ),
    );
  }

  // Step 2 — auth
  console.log();
  const authMethod = await select({
    choices: [
      { name: "API key — environment variable", value: "env" },
      { name: "API key — file on disk", value: "file" },
      { name: "OAuth (browser login via claude)", value: "oauth" },
    ],
    message: "[2/5] Auth method",
  });

  let authConfig: ProfileConfigInput["auth"];
  if (authMethod === "env") {
    const keyEnv = await input({
      default: "ANTHROPIC_API_KEY",
      message: "     Env var name",
    });
    authConfig = { keyEnv, type: "api-key" };
  } else if (authMethod === "file") {
    const keyFile = await input({
      default: "~/.anthropic/api_key",
      message: "     Key file path",
    });
    authConfig = { keyFile, type: "api-key" };
  } else {
    authConfig = { type: "oauth" };
    console.log(
      chalk.dim(
        "     OAuth tokens will be stored in ~/.ccpod/credentials/default/",
      ),
    );
  }

  // Step 3 — config source
  console.log();
  const configSource = await select({
    choices: [
      { name: "Start empty", value: "empty" },
      { name: "Local directory", value: "local" },
      { name: "Git repository", value: "git" },
    ],
    message:
      "[3/5] Config source (CLAUDE.md, settings.json, skills, extensions)",
  });

  let configConfig: ProfileConfigInput["config"];
  if (configSource === "empty") {
    const emptyDir = join(PROFILES_DIR, profileName, "config");
    mkdirSync(emptyDir, { recursive: true });
    configConfig = { path: emptyDir, source: "local" };
  } else if (configSource === "local") {
    const path = await input({ message: "     Config directory path" });
    configConfig = { path, source: "local" };
  } else {
    const repo = await input({ message: "     Git repo URL" });
    const ref = await input({
      default: "main",
      message: "     Branch / tag / ref",
    });
    const sync = (await select({
      choices: [
        { name: "Daily (once per day)", value: "daily" },
        { name: "Always (every run)", value: "always" },
        { name: "Pin (never update)", value: "pin" },
      ],
      message: "     Sync strategy",
    })) as "always" | "daily" | "pin";
    configConfig = { ref, repo, source: "git", sync };
  }

  // Step 4 — network policy
  console.log();
  const networkPolicy = (await select({
    choices: [
      { name: "Full — unrestricted outbound", value: "full" },
      { name: "Restricted — iptables allow-list", value: "restricted" },
    ],
    message: "[4/5] Default network policy",
  })) as "full" | "restricted";

  // Step 5 — confirm & write
  console.log();
  const profileDir = join(PROFILES_DIR, profileName);

  if (profileExists(profileName)) {
    const overwrite = await confirm({
      default: false,
      message: `[5/5] Profile '${profileName}' already exists. Overwrite?`,
    });
    if (!overwrite) {
      console.log("Aborted.");
      return;
    }
  } else {
    const ok = await confirm({
      default: true,
      message: `[5/5] Write profile '${profileName}' to ${profileDir}?`,
    });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  ensureCcpodDirs();
  mkdirSync(profileDir, { recursive: true });

  const profile: ProfileConfigInput = {
    auth: authConfig,
    config: configConfig,
    env: [],
    image: { use: "ghcr.io/yorch/ccpod:latest" },
    name: profileName,
    network: { allow: [], policy: networkPolicy },
    ports: { autoDetectMcp: true, list: [] },
    services: {},
    ssh: { agentForward: true, mountSshDir: false },
    state: "ephemeral",
  };

  writeFileSync(
    join(profileDir, "profile.yml"),
    yamlStringify(profile),
    "utf8",
  );

  console.log(chalk.green(`\n✓ Profile '${profileName}' created.`));
  console.log(chalk.dim(`  ${join(profileDir, "profile.yml")}`));
  console.log(chalk.dim("\nRun 'ccpod run' to launch Claude Code.\n"));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
