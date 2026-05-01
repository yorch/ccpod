import { defineCommand } from "citty";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { loadProjectConfig } from "../../../config/loader.ts";
import { profileExists } from "../../../profile/manager.ts";
import { stateVolumeName, volumeExists, removeVolume } from "../../../plugins/volume.ts";

export default defineCommand({
  meta: { description: "Clear persistent state volume for a profile" },
  args: {
    profile: { type: "string", description: "Profile name" },
    force: { type: "boolean", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? "default";

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    const volName = stateVolumeName(profileName);
    const exists = await volumeExists(volName);

    if (!exists) {
      console.log(`No persistent state volume for '${profileName}' (profile may use ephemeral state).`);
      return;
    }

    if (!args.force) {
      const ok = await confirm({
        message: `Remove state volume ${chalk.cyan(volName)}? This deletes all saved projects, todos, and conversation history.`,
        default: false,
      });
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    process.stdout.write(`Removing ${chalk.cyan(volName)}... `);
    await removeVolume(volName);
    console.log(chalk.green("done"));
  },
});
