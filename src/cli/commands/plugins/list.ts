import chalk from "chalk";
import { defineCommand } from "citty";
import { loadProjectConfig } from "../../../config/loader.ts";
import {
  listVolumeEntries,
  pluginsVolumeName,
  volumeExists,
} from "../../../plugins/volume.ts";
import { profileExists } from "../../../profile/manager.ts";

export default defineCommand({
  args: {
    profile: {
      description: "Profile name (default: from .ccpod.yml or 'default')",
      type: "string",
    },
  },
  meta: { description: "List plugins installed in a profile's volume" },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? "default";

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    const volName = pluginsVolumeName(profileName);
    const exists = await volumeExists(volName);

    if (!exists) {
      console.log(
        `No plugins volume for profile '${profileName}'. Run 'ccpod run' to create it.`,
      );
      return;
    }

    console.log(chalk.dim(`Volume: ${volName}\n`));

    let entries: string[];
    try {
      entries = await listVolumeEntries(volName, "/plugins");
    } catch (_e) {
      console.log(
        chalk.yellow(
          "Could not inspect volume (is Docker running with alpine image available?).",
        ),
      );
      console.log(
        chalk.dim(
          `Manual inspect: docker run --rm -v ${volName}:/p alpine ls /p`,
        ),
      );
      return;
    }

    const visible = entries.filter((e) => !e.startsWith("."));
    if (visible.length === 0) {
      console.log("No plugins installed yet.");
    } else {
      for (const entry of visible) {
        console.log(`  ${entry}`);
      }
      console.log(chalk.dim(`\n${visible.length} plugin(s)`));
    }
  },
});
