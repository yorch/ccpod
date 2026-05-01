import { defineCommand } from "citty";
import chalk from "chalk";
import { listProfiles, getProfileDir } from "../../../profile/manager.ts";
import { loadProfileConfig } from "../../../config/loader.ts";
import { getLastSync } from "../../../profile/lock.ts";

export default defineCommand({
  meta: { description: "List all profiles" },
  run() {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log("No profiles found. Run `ccpod init` to create one.");
      return;
    }

    const rows = profiles.map((name) => {
      const profileDir = getProfileDir(name);
      try {
        const cfg = loadProfileConfig(profileDir);
        const lastSync = getLastSync(profileDir);
        const syncStr = lastSync ? lastSync.toLocaleDateString() : "-";
        const source = cfg.config.source === "git" ? `git (${cfg.config.sync})` : "local";
        return { name, image: cfg.image.use, source, state: cfg.state, sync: syncStr };
      } catch {
        return { name, image: chalk.red("[invalid]"), source: "-", state: "-", sync: "-" };
      }
    });

    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const imageW = Math.max(5, ...rows.map((r) => r.image.replace(/\x1b\[[0-9;]*m/g, "").length));
    const sourceW = Math.max(6, ...rows.map((r) => r.source.length));
    const stateW = Math.max(5, ...rows.map((r) => r.state.length));

    const pad = (s: string, w: number) => s + " ".repeat(w - s.replace(/\x1b\[[0-9;]*m/g, "").length);

    console.log(
      chalk.dim(
        `${pad("NAME", nameW)}  ${pad("IMAGE", imageW)}  ${pad("SOURCE", sourceW)}  ${pad("STATE", stateW)}  LAST SYNC`,
      ),
    );
    for (const r of rows) {
      console.log(
        `${chalk.cyan(pad(r.name, nameW))}  ${pad(r.image, imageW)}  ${pad(r.source, sourceW)}  ${pad(r.state, stateW)}  ${r.sync}`,
      );
    }
  },
});
