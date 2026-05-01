import { rmSync } from "node:fs";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { defineCommand } from "citty";
import { loadProjectConfig } from "../../../config/loader.ts";
import { dockerExec } from "../../../runtime/docker.ts";
import { getStateDir, profileExists } from "../../../profile/manager.ts";

async function hasRunningContainer(profileName: string): Promise<boolean> {
  const { stdout } = await dockerExec([
    "ps",
    "--filter",
    `label=ccpod.profile=${profileName}`,
    "--filter",
    "status=running",
    "--quiet",
  ]);
  return stdout.trim().length > 0;
}

export default defineCommand({
  args: {
    force: {
      default: false,
      description: "Skip confirmation prompt",
      type: "boolean",
    },
    profile: { description: "Profile name", type: "string" },
  },
  meta: { description: "Clear persistent state for a profile" },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? "default";

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    if (await hasRunningContainer(profileName)) {
      console.error(
        `A ccpod container for '${profileName}' is still running. Stop it first with: ccpod down`,
      );
      process.exit(1);
    }

    const stateDir = getStateDir(profileName);

    if (!args.force) {
      const ok = await confirm({
        default: false,
        message: `Remove state at ${chalk.cyan(stateDir)}? This deletes all saved projects, todos, and conversation history.`,
      });
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    process.stdout.write(`Removing ${chalk.cyan(stateDir)}... `);
    rmSync(stateDir, { force: true, recursive: true });
    console.log(chalk.green("done"));
  },
});
