import { defineCommand } from "citty";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import chalk from "chalk";
import { loadProfileConfig, loadProjectConfig } from "../../../config/loader.ts";
import { mergeConfigs, mergeClaudes } from "../../../config/merger.ts";
import { profileExists, getProfileDir } from "../../../profile/manager.ts";

export default defineCommand({
  meta: { description: "Show effective merged config for the current directory" },
  args: {
    profile: { type: "string", description: "Override profile name" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run({ args }) {
    const cwd = process.cwd();
    const projectConfig = loadProjectConfig(cwd);
    const profileName = args.profile ?? projectConfig?.profile ?? "default";

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found. Run 'ccpod init'.`);
      process.exit(1);
    }

    const profile = loadProfileConfig(getProfileDir(profileName));
    const merged = mergeConfigs(profile, projectConfig);

    // Mask sensitive env values
    const envDisplay: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged.env)) {
      envDisplay[k] = k.toLowerCase().includes("key") || k.toLowerCase().includes("token")
        ? `${"*".repeat(Math.min(v.length, 8))} (${v.length} chars)`
        : v;
    }

    const display = {
      profile: merged.profileName,
      image: merged.image === "build" ? `build (${merged.dockerfile ?? "Dockerfile"})` : merged.image,
      state: merged.state,
      auth: merged.auth,
      ssh: merged.ssh,
      network: merged.network,
      ports: merged.ports,
      autoDetectMcp: merged.autoDetectMcp,
      services: merged.services,
      env: envDisplay,
    };

    if (args.json) {
      console.log(JSON.stringify(display, null, 2));
      return;
    }

    console.log(chalk.bold(`\nMerged config — profile '${profileName}'\n`));
    console.log(yamlStringify(display));

    // Show CLAUDE.md preview
    const configSourceDir =
      profile.config.source === "local"
        ? profile.config.path ?? getProfileDir(profileName)
        : join(getProfileDir(profileName), "config");

    const profileMd = readIfExists(join(configSourceDir, "CLAUDE.md"));
    const projectMd = readIfExists(join(cwd, "CLAUDE.md"));

    if (profileMd || projectMd) {
      const mode = projectConfig?.config?.claudeMd ?? "append";
      const merged = mergeClaudes(profileMd ?? "", projectMd ?? "", mode);
      console.log(chalk.bold("CLAUDE.md") + chalk.dim(` (${mode} mode, ${merged.length} chars)`));
      const preview = merged.split("\n").slice(0, 8).join("\n");
      console.log(chalk.dim(preview));
      if (merged.split("\n").length > 8) console.log(chalk.dim("..."));
      console.log();
    }
  },
});

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
