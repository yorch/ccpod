import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
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
    buildAnnotatedProfileYaml(profile),
    "utf8",
  );

  console.log(chalk.green(`\n✓ Profile '${profileName}' created.`));
  console.log(chalk.dim(`  ${join(profileDir, "profile.yml")}`));
  console.log(chalk.dim("\nRun 'ccpod run' to launch Claude Code.\n"));
}

export function q(val: string): string {
  if (/[\s:#[\]{},!*&|>%@`?]/.test(val) || val.startsWith("-")) {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return val;
}

export function buildAnnotatedProfileYaml(profile: ProfileConfigInput): string {
  const s: string[] = [];

  s.push(
    "# Profile identifier — used in container/volume names and credential paths.",
  );
  s.push(`name: ${q(profile.name)}`);
  s.push("");

  s.push("# Authentication with the Anthropic API.");
  s.push(
    "# type: api-key (env var or file on disk) | oauth (browser login via claude)",
  );
  if (profile.auth?.type === "api-key") {
    if (profile.auth.keyFile) {
      s.push("# keyFile: path to a plaintext file containing the API key");
    } else {
      s.push("# keyEnv: name of the host env var that holds the API key");
    }
  }
  s.push("auth:");
  s.push(`  type: ${profile.auth?.type ?? "api-key"}`);
  if (profile.auth?.type === "api-key") {
    if (profile.auth.keyFile) {
      s.push(`  keyFile: ${q(profile.auth.keyFile)}`);
    } else {
      s.push(`  keyEnv: ${profile.auth?.keyEnv ?? "ANTHROPIC_API_KEY"}`);
    }
  }
  s.push("");

  s.push(
    "# Source for Claude config files (CLAUDE.md, settings.json, skills, extensions).",
  );
  s.push("# source: local — read from a directory on disk");
  s.push(
    "# source: git   — clone/pull from a git repo; supports ref and sync strategy",
  );
  s.push("# sync: always | daily | pin — how often to pull updates (git only)");
  s.push("config:");
  s.push(`  source: ${profile.config?.source}`);
  if (profile.config?.path) s.push(`  path: ${q(profile.config.path)}`);
  if (profile.config?.repo) s.push(`  repo: ${q(profile.config.repo)}`);
  if (profile.config?.ref) s.push(`  ref: ${q(profile.config.ref)}`);
  if (profile.config?.sync) s.push(`  sync: ${profile.config.sync}`);
  s.push("");

  s.push("# Extra environment variables passed into the container.");
  s.push("# Format: KEY=VALUE (explicit) or KEY (inherit value from host).");
  s.push(`env: []`);
  s.push("");

  s.push("# Docker image used to run Claude Code.");
  s.push("# use: image reference (registry/repo:tag)");
  s.push(
    "# dockerfile: path to a local Dockerfile to build instead of pulling.",
  );
  s.push("image:");
  s.push(`  use: ${q(profile.image?.use ?? "ghcr.io/yorch/ccpod:latest")}`);
  if (profile.image?.dockerfile)
    s.push(`  dockerfile: ${q(profile.image.dockerfile)}`);
  s.push("");

  s.push("# Network policy applied to the container.");
  s.push("# policy: full — unrestricted outbound access");
  s.push(
    "# policy: restricted — iptables allow-list; add permitted hosts/CIDRs to 'allow'",
  );
  s.push("network:");
  s.push(`  policy: ${profile.network?.policy ?? "full"}`);
  s.push(`  allow: []`);
  s.push("");

  s.push("# Port mappings and MCP server discovery.");
  s.push("# autoDetectMcp: automatically expose ports declared in .mcp.json");
  s.push('# list: additional host:container port pairs, e.g. "8080:8080"');
  s.push("ports:");
  s.push(`  autoDetectMcp: ${profile.ports?.autoDetectMcp ?? true}`);
  s.push(`  list: []`);
  s.push("");

  s.push(
    "# Sidecar containers started alongside Claude Code (databases, proxies, etc.).",
  );
  s.push(
    "# Each key is a service name. Fields: image (required), ports, volumes, env.",
  );
  s.push("services: {}");
  s.push("");

  s.push("# SSH configuration.");
  s.push(
    "# agentForward: forward the host SSH agent socket into the container",
  );
  s.push("# mountSshDir: bind-mount ~/.ssh (read-only) for direct key access");
  s.push("ssh:");
  s.push(`  agentForward: ${profile.ssh?.agentForward ?? true}`);
  s.push(`  mountSshDir: ${profile.ssh?.mountSshDir ?? false}`);
  s.push("");

  s.push("# Session state persistence across container restarts.");
  s.push(
    "# ephemeral:  conversation history and todos lost when container is removed",
  );
  s.push(
    "# persistent: stored in a named Docker volume; survives container removal",
  );
  s.push(`state: ${profile.state ?? "ephemeral"}`);
  s.push("");

  return s.join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
