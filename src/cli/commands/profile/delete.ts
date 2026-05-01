import { defineCommand } from "citty";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { profileExists, deleteProfile } from "../../../profile/manager.ts";

export default defineCommand({
  meta: { description: "Delete a profile" },
  args: {
    name: { type: "positional", description: "Profile name" },
    force: { type: "boolean", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    if (!args.name) {
      console.error("Profile name required.");
      process.exit(1);
    }

    if (!profileExists(args.name)) {
      console.error(`Profile '${args.name}' not found.`);
      process.exit(1);
    }

    if (!args.force) {
      const ok = await confirm({
        message: `Delete profile ${chalk.cyan(args.name)}? This removes the profile config and cannot be undone.`,
        default: false,
      });
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    deleteProfile(args.name);
    console.log(`Profile ${chalk.cyan(args.name)} deleted.`);
  },
});
