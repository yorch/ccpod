import { defineCommand } from "citty";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAuth, resolveEnvForwarding } from "../../auth/resolver.ts";
import { mergeConfigs, mergeClaudes } from "../../config/merger.ts";
import { loadProfileConfig, loadProjectConfig } from "../../config/loader.ts";
import { writeMergedConfig } from "../../config/writer.ts";
import { buildContainerSpec } from "../../container/builder.ts";
import { runContainer } from "../../container/runner.ts";
import { ensureImage, buildImage } from "../../image/manager.ts";
import { parseMcpJson, extractHttpMcpPorts } from "../../mcp/parser.ts";
import { profileExists, getProfileDir } from "../../profile/manager.ts";
import { syncGitConfig } from "../../profile/git-sync.ts";
import type { ResolvedConfig } from "../../types/index.ts";

export default defineCommand({
  meta: { description: "Run Claude Code in a container (interactive or headless)" },
  args: {
    profile: { type: "string", description: "Profile name (overrides .ccpod.yml)" },
    env: { type: "string", description: "Pass/override env var (KEY or KEY=VALUE)", array: true },
    rebuild: { type: "boolean", description: "Force image rebuild/repull", default: false },
    "no-state": { type: "boolean", description: "Force ephemeral state for this run", default: false },
    file: { type: "string", description: "Headless mode: path to prompt file" },
  },
  async run({ args }) {
    const cwd = process.cwd();

    // 1. Load project config first to get profile hint
    const projectConfig = loadProjectConfig(cwd);
    const profileName = args.profile ?? projectConfig?.profile ?? "default";

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found. Run 'ccpod init' to create one.`);
      process.exit(1);
    }

    // 2. Load + sync profile
    const profileDir = getProfileDir(profileName);
    const profile = loadProfileConfig(profileDir);

    if (profile.config.source === "git" && profile.config.repo) {
      await syncGitConfig(
        profileDir,
        profile.config.repo,
        profile.config.ref ?? "main",
        profile.config.sync ?? "daily",
      );
    }

    // 3. Merge profile + project
    const stateOverride = args["no-state"] ? ("ephemeral" as const) : undefined;
    const partial = mergeConfigs(profile, projectConfig, { state: stateOverride });

    // 4. MCP port auto-detection
    const mcpPorts = partial.autoDetectMcp
      ? (parseMcpJson(cwd)
          ? extractHttpMcpPorts(parseMcpJson(cwd)!).map((port) => ({ host: port, container: port }))
          : [])
      : [];

    // 5. Resolve environment
    const envArgs = ([] as string[]).concat(args.env ?? []);
    const env = {
      ...resolveEnvForwarding(profile.env, projectConfig?.env ?? [], envArgs),
      ...resolveAuth(profile.auth),
    };

    // 6. Build merged ~/.claude config dir
    const configSourceDir =
      profile.config.source === "local"
        ? profile.config.path ?? profileDir
        : join(profileDir, "config");

    const profileClaudeMd = readIfExists(join(configSourceDir, "CLAUDE.md"));
    const projectClaudeMd = readIfExists(join(cwd, "CLAUDE.md"));
    const claudeMdMode = projectConfig?.config?.claudeMd ?? "append";
    const mergedClaudeMd =
      profileClaudeMd || projectClaudeMd
        ? mergeClaudes(profileClaudeMd ?? "", projectClaudeMd ?? "", claudeMdMode)
        : "";

    const profileSettings = readJsonIfExists(join(configSourceDir, "settings.json")) ?? {};
    const mergedConfigDir = writeMergedConfig(configSourceDir, mergedClaudeMd, profileSettings);

    // 7. Resolve image — build locally if use === "build", else pull
    let image = partial.image;
    if (image === "build") {
      const tag = `ccpod-local-${profileName}:latest`;
      const dockerfile = partial.dockerfile ?? "Dockerfile";
      await buildImage(dockerfile, tag, cwd);
      image = tag;
    } else {
      await ensureImage(image, args.rebuild ?? false);
    }

    // 8. Build full config
    const config: ResolvedConfig = {
      ...partial,
      image,
      ports: [...partial.ports, ...mcpPorts],
      env,
      mergedConfigDir,
      claudeArgs: args.file ? ["--file", `/workspace/${args.file}`] : [],
    };

    // 9. Launch
    const tty = !args.file;
    const spec = buildContainerSpec(config, cwd, tty);
    const exitCode = await runContainer(spec);
    process.exit(exitCode);
  },
});

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readJsonIfExists(path: string): object | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as object;
  } catch {
    return null;
  }
}
