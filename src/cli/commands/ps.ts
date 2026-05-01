import { defineCommand } from "citty";
import chalk from "chalk";
import { getDockerClient } from "../../runtime/client.ts";

export default defineCommand({
  meta: { description: "List ccpod containers" },
  args: {
    all: { type: "boolean", description: "Include stopped containers", default: false },
  },
  async run({ args }) {
    const docker = await getDockerClient();
    const containers = await docker.listContainers({
      all: args.all ?? false,
      filters: JSON.stringify({ label: ["ccpod.profile"] }),
    });

    if (containers.length === 0) {
      console.log("No ccpod containers" + (args.all ? "." : " running. Use --all to include stopped."));
      return;
    }

    const col = (s: string, w: number) => s.slice(0, w).padEnd(w);
    const HEADER = `${"CONTAINER".padEnd(32)} ${"PROFILE".padEnd(16)} ${"STATE".padEnd(10)} ${"IMAGE".padEnd(34)} WORKDIR`;
    console.log(chalk.bold(HEADER));
    console.log(chalk.dim("─".repeat(HEADER.length)));

    for (const c of containers) {
      const labels = c.Labels ?? {};
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      const profile = labels["ccpod.profile"] ?? "-";
      const workdir = labels["ccpod.workdir"] ?? labels["ccpod.project"] ?? "-";
      const image = c.Image;

      const stateRaw = c.State;
      const stateColored =
        stateRaw === "running"
          ? chalk.green(stateRaw)
          : chalk.yellow(stateRaw);
      const statePad = " ".repeat(Math.max(0, 10 - stateRaw.length));

      console.log(
        `${col(name, 32)} ${col(profile, 16)} ${stateColored}${statePad} ${col(image, 34)} ${workdir}`,
      );
    }
  },
});
