import chalk from "chalk";
import { defineCommand } from "citty";
import { loadProfileConfig } from "../../../config/loader.ts";
import { syncGitConfig } from "../../../profile/git-sync.ts";
import { getProfileDir, profileExists } from "../../../profile/manager.ts";

export default defineCommand({
  args: { name: { description: "Profile name", type: "positional" } },
  meta: { description: "Force-sync a profile's config source" },
  async run({ args }) {
    if (!args.name) {
      console.error("Profile name required");
      process.exit(1);
    }

    if (!profileExists(args.name)) {
      console.error(`Profile '${args.name}' not found.`);
      process.exit(1);
    }

    const profileDir = getProfileDir(args.name);
    const profile = loadProfileConfig(profileDir);

    if (profile.config.source === "git") {
      const repo = profile.config.repo;
      if (!repo) {
        console.error("Profile has source=git but no repo URL.");
        process.exit(1);
      }
      console.log(chalk.dim(`Syncing ${repo}...`));
      // Force sync by using "always" strategy regardless of lock
      await syncGitConfig(
        profileDir,
        repo,
        profile.config.ref ?? "main",
        "always",
      );
      console.log(chalk.green(`✓ '${args.name}' config synced.`));
    } else {
      // Local source — just verify the path exists
      const { existsSync } = await import("node:fs");
      const path = profile.config.path ?? profileDir;
      if (existsSync(path)) {
        console.log(
          chalk.green(`✓ '${args.name}' local config path exists: ${path}`),
        );
      } else {
        console.log(chalk.yellow(`⚠ Config path not found: ${path}`));
      }
    }
  },
});
