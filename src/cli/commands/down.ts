import { defineCommand } from "citty";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { getDockerClient } from "../../runtime/client.ts";

export default defineCommand({
  meta: { description: "Stop and remove ccpod containers for the current project" },
  args: {
    all: { type: "boolean", description: "Stop all ccpod containers on this machine", default: false },
    profile: { type: "string", description: "Limit to a specific profile" },
  },
  async run({ args }) {
    const docker = await getDockerClient();
    const projectHash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);

    const labelFilters: string[] = args.all
      ? ["ccpod.profile"]
      : [`ccpod.project=${projectHash}`];

    if (!args.all && args.profile) {
      labelFilters.push(`ccpod.profile=${args.profile}`);
    }

    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: labelFilters }),
    });

    if (containers.length === 0) {
      console.log("No ccpod containers found" + (args.all ? "." : " for this project."));
      return;
    }

    for (const c of containers) {
      const name = (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
      const container = docker.getContainer(c.Id);

      if (c.State === "running") {
        process.stdout.write(`Stopping ${chalk.cyan(name)}... `);
        await container.stop({ t: 5 });
        console.log(chalk.green("done"));
      }

      process.stdout.write(`Removing ${chalk.cyan(name)}... `);
      await container.remove();
      console.log(chalk.green("done"));
    }
  },
});
