import { createHash } from "node:crypto";
import chalk from "chalk";
import { defineCommand } from "citty";
import {
  removeSidecarNetwork,
  sidecarNetworkName,
} from "../../container/sidecars.ts";
import { dockerExec } from "../../runtime/docker.ts";

export default defineCommand({
  args: {
    all: {
      default: false,
      description: "Stop all ccpod containers on this machine",
      type: "boolean",
    },
    profile: { description: "Limit to a specific profile", type: "string" },
  },
  meta: {
    description: "Stop and remove ccpod containers for the current project",
  },
  async run({ args }) {
    const projectHash = createHash("sha256")
      .update(process.cwd())
      .digest("hex")
      .slice(0, 16);

    const filterArgs: string[] = args.all
      ? ["--filter", "label=ccpod.profile"]
      : ["--filter", `label=ccpod.project=${projectHash}`];

    if (!args.all && args.profile) {
      filterArgs.push("--filter", `label=ccpod.profile=${args.profile}`);
    }

    const { stdout } = await dockerExec(["ps", "-a", "-q", ...filterArgs]);
    const ids = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      console.log(
        `No ccpod containers found${args.all ? "." : " for this project."}`,
      );
      return;
    }

    for (const id of ids) {
      const { stdout: nameOut } = await dockerExec([
        "inspect",
        "--format",
        "{{.Name}}",
        id,
      ]);
      const name = nameOut.replace(/^\//, "") || id.slice(0, 12);

      const { stdout: statusOut } = await dockerExec([
        "inspect",
        "--format",
        "{{.State.Status}}",
        id,
      ]);
      if (statusOut === "running") {
        process.stdout.write(`Stopping ${chalk.cyan(name)}... `);
        const stopResult = await dockerExec(["stop", "-t", "5", id]);
        if (stopResult.exitCode !== 0) {
          console.log(chalk.red("failed"));
          console.error(`  ${stopResult.stderr}`);
          continue;
        }
        console.log(chalk.green("done"));
      }

      process.stdout.write(`Removing ${chalk.cyan(name)}... `);
      const rmResult = await dockerExec(["rm", id]);
      if (rmResult.exitCode !== 0) {
        console.log(chalk.red("failed"));
        console.error(`  ${rmResult.stderr}`);
      } else {
        console.log(chalk.green("done"));
      }
    }

    // Remove shared sidecar network for this project (idempotent — ignore errors)
    if (!args.all) {
      await removeSidecarNetwork(sidecarNetworkName(projectHash)).catch(
        () => {},
      );
    }
  },
});
