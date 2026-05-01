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
    message: "[2/5] Auth method",
    choices: [
      { name: "API key — environment variable", value: "env" },
      { name: "API key — file on disk", value: "file" },
      { name: "OAuth (browser login via claude)", value: "oauth" },
    ],
  });

  let authConfig: ProfileConfigInput["auth"];
  if (authMethod === "env") {
    const keyEnv = await input({
      message: "     Env var name",
      default: "ANTHROPIC_API_KEY",
    });
    authConfig = { type: "api-key", keyEnv };
  } else if (authMethod === "file") {
    const keyFile = await input({
      message: "     Key file path",
      default: "~/.anthropic/api_key",
    });
    authConfig = { type: "api-key", keyFile };
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
    message:
      "[3/5] Config source (CLAUDE.md, settings.json, skills, extensions)",
    choices: [
      { name: "Start empty", value: "empty" },
      { name: "Local directory", value: "local" },
      { name: "Git repository", value: "git" },
    ],
  });

  let configConfig: ProfileConfigInput["config"];
  if (configSource === "empty") {
    const emptyDir = join(PROFILES_DIR, profileName, "config");
    mkdirSync(emptyDir, { recursive: true });
    configConfig = { source: "local", path: emptyDir };
  } else if (configSource === "local") {
    const path = await input({ message: "     Config directory path" });
    configConfig = { source: "local", path };
  } else {
    const repo = await input({ message: "     Git repo URL" });
    const ref = await input({
      message: "     Branch / tag / ref",
      default: "main",
    });
    const sync = (await select({
      message: "     Sync strategy",
      choices: [
        { name: "Daily (once per day)", value: "daily" },
        { name: "Always (every run)", value: "always" },
        { name: "Pin (never update)", value: "pin" },
      ],
    })) as "always" | "daily" | "pin";
    configConfig = { source: "git", repo, ref, sync };
  }

  // Step 4 — network policy
  console.log();
  const networkPolicy = (await select({
    message: "[4/5] Default network policy",
    choices: [
      { name: "Full — unrestricted outbound", value: "full" },
      { name: "Restricted — iptables allow-list", value: "restricted" },
    ],
  })) as "full" | "restricted";

  // Step 5 — confirm & write
  console.log();
  const profileDir = join(PROFILES_DIR, profileName);

  if (profileExists(profileName)) {
    const overwrite = await confirm({
      message: `[5/5] Profile '${profileName}' already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log("Aborted.");
      return;
    }
  } else {
    const ok = await confirm({
      message: `[5/5] Write profile '${profileName}' to ${profileDir}?`,
      default: true,
    });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  ensureCcpodDirs();
  mkdirSync(profileDir, { recursive: true });

  const profile: ProfileConfigInput = {
    name: profileName,
    config: configConfig,
    auth: authConfig,
    image: { use: "ghcr.io/ccpod/base:latest" },
    state: "ephemeral",
    ssh: { agentForward: true, mountSshDir: false },
    network: { policy: networkPolicy, allow: [] },
    ports: { list: [], autoDetectMcp: true },
    services: {},
    env: [],
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
