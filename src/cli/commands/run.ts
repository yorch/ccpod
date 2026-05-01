import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import chalk from "chalk";
import { defineCommand } from "citty";
import { ZodError } from "zod";
import { resolveAuth, resolveEnvForwarding } from "../../auth/resolver.ts";
import { loadProfileConfig, loadProjectConfig } from "../../config/loader.ts";
import { mergeClaudes, mergeConfigs } from "../../config/merger.ts";
import { writeMergedConfig } from "../../config/writer.ts";
import {
  buildContainerSpec,
  computeProjectHash,
} from "../../container/builder.ts";
import { runContainer } from "../../container/runner.ts";
import { sidecarNetworkName, startSidecars } from "../../container/sidecars.ts";
import { buildImage, ensureImage } from "../../image/manager.ts";
import { extractHttpMcpPorts, parseMcpJson } from "../../mcp/parser.ts";
import { syncGitConfig } from "../../profile/git-sync.ts";
import { getProfileDir, profileExists } from "../../profile/manager.ts";
import type { ResolvedConfig } from "../../types/index.ts";

export default defineCommand({
  args: {
    env: {
      array: true,
      description: "Pass/override env var (KEY or KEY=VALUE)",
      type: "string",
    },
    file: { description: "Headless mode: path to prompt file", type: "string" },
    "no-state": {
      default: false,
      description: "Force ephemeral state for this run",
      type: "boolean",
    },
    profile: {
      description: "Profile name (overrides .ccpod.yml)",
      type: "string",
    },
    rebuild: {
      default: false,
      description: "Force image rebuild/repull",
      type: "boolean",
    },
  },
  meta: {
    description: "Run Claude Code in a container (interactive or headless)",
  },
  async run({ args }) {
    try {
      const cwd = process.cwd();

      // Validate --file is a relative path within the project directory
      let fileArg: string | undefined;
      if (args.file) {
        const normalized = normalize(args.file);
        if (isAbsolute(normalized) || normalized.startsWith("..")) {
          console.error(
            `${chalk.red("error:")} --file must be a relative path within the project directory`,
          );
          process.exit(1);
        }
        fileArg = normalized;
      }

      // 1. Load project config first to get profile hint
      const projectConfig = loadProjectConfig(cwd);
      const profileName = args.profile ?? projectConfig?.profile ?? "default";

      if (!profileExists(profileName)) {
        console.error(
          `Profile '${profileName}' not found. Run 'ccpod init' to create one.`,
        );
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
      const stateOverride = args["no-state"]
        ? ("ephemeral" as const)
        : undefined;
      const partial = mergeConfigs(profile, projectConfig, {
        state: stateOverride,
      });

      // 4. MCP port auto-detection
      const mcpJson = partial.autoDetectMcp ? parseMcpJson(cwd) : null;
      const mcpPorts = mcpJson
        ? extractHttpMcpPorts(mcpJson).map((port) => ({
            container: port,
            host: port,
          }))
        : [];

      // 5. Resolve environment
      const envArgs = ([] as string[]).concat(args.env ?? []);
      const authEnv = resolveAuth(profile.auth);

      // Headless mode requires auth — fail early to avoid a useless container run
      if (
        fileArg &&
        profile.auth.type === "api-key" &&
        Object.keys(authEnv).length === 0
      ) {
        console.error(
          `${chalk.red("error:")} Headless mode requires auth. Set ${profile.auth.keyEnv ?? "ANTHROPIC_API_KEY"} or configure keyFile.`,
        );
        process.exit(1);
      }

      const env = {
        ...resolveEnvForwarding(profile.env, projectConfig?.env ?? [], envArgs),
        ...authEnv,
      };

      // 6. Build merged ~/.claude config dir
      const configSourceDir =
        profile.config.source === "local"
          ? (profile.config.path ?? profileDir)
          : join(profileDir, "config");

      const profileClaudeMd = readIfExists(join(configSourceDir, "CLAUDE.md"));
      const projectClaudeMd = readIfExists(join(cwd, "CLAUDE.md"));
      const claudeMdMode = projectConfig?.config?.claudeMd ?? "append";
      const mergedClaudeMd =
        profileClaudeMd || projectClaudeMd
          ? mergeClaudes(
              profileClaudeMd ?? "",
              projectClaudeMd ?? "",
              claudeMdMode,
            )
          : "";

      const profileSettings =
        readJsonIfExists(join(configSourceDir, "settings.json")) ?? {};
      const mergedConfigDir = writeMergedConfig(
        configSourceDir,
        mergedClaudeMd,
        profileSettings,
      );

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
        claudeArgs: fileArg ? ["--file", `/workspace/${fileArg}`] : [],
        env,
        image,
        mergedConfigDir,
        ports: [...partial.ports, ...mcpPorts],
      };

      // 9. Start sidecars (if any) and launch
      const hash = computeProjectHash(cwd);
      let networkName: string | undefined;

      if (Object.keys(config.services).length > 0) {
        networkName = sidecarNetworkName(hash);
        console.log(chalk.bold("Starting sidecars..."));
        await startSidecars(config.services, networkName, profileName, hash);
      }

      const tty = !fileArg;
      const spec = buildContainerSpec(config, cwd, tty, networkName);
      const exitCode = await runContainer(spec);
      process.exit(exitCode);
    } catch (err) {
      if (err instanceof ZodError) {
        const lines = err.issues.map(
          (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
        );
        console.error(
          `${chalk.red("error:")} Config validation failed:\n${lines.join("\n")}`,
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${chalk.red("error:")} ${msg}`);
      }
      process.exit(1);
    }
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
