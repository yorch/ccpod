import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { defineCommand } from "citty";
import { loadProjectConfig } from "../../../config/loader.ts";
import {
  removeVolume,
  stateVolumeName,
  volumeExists,
} from "../../../plugins/volume.ts";
import { profileExists } from "../../../profile/manager.ts";

export default defineCommand({
  args: {
    force: {
      default: false,
      description: "Skip confirmation prompt",
      type: "boolean",
    },
    profile: { description: "Profile name", type: "string" },
  },
  meta: { description: "Clear persistent state volume for a profile" },
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
      console.log(
        `No persistent state volume for '${profileName}' (profile may use ephemeral state).`,
      );
      return;
    }

    if (!args.force) {
      const ok = await confirm({
        default: false,
        message: `Remove state volume ${chalk.cyan(volName)}? This deletes all saved projects, todos, and conversation history.`,
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
