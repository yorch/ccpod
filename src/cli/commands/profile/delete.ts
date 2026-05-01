import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { defineCommand } from "citty";
import { deleteProfile, profileExists } from "../../../profile/manager.ts";

export default defineCommand({
  args: {
    force: {
      default: false,
      description: "Skip confirmation prompt",
      type: "boolean",
    },
    name: { description: "Profile name", type: "positional" },
  },
  meta: { description: "Delete a profile" },
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
        default: false,
        message: `Delete profile ${chalk.cyan(args.name)}? This removes the profile config and cannot be undone.`,
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
