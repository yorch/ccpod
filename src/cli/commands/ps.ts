import chalk from "chalk";
import { defineCommand } from "citty";
import { dockerExec } from "../../runtime/docker.ts";

type PsRow = { Names: string; Image: string; Status: string; Labels: string };

function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq >= 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export default defineCommand({
  args: {
    all: {
      default: false,
      description: "Include stopped containers",
      type: "boolean",
    },
  },
  meta: { description: "List ccpod containers" },
  async run({ args }) {
    const filterArgs = args.all ? ["-a"] : [];
    const { stdout } = await dockerExec([
      "ps",
      ...filterArgs,
      "--filter",
      "label=ccpod.profile",
      "--format",
      "{{json .}}",
    ]);

    if (!stdout) {
      console.log(
        "No ccpod containers" +
          (args.all ? "." : " running. Use --all to include stopped."),
      );
      return;
    }

    const containers = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PsRow);

    if (containers.length === 0) {
      console.log(
        "No ccpod containers" +
          (args.all ? "." : " running. Use --all to include stopped."),
      );
      return;
    }

    const col = (s: string, w: number) => s.slice(0, w).padEnd(w);
    const HEADER = `${"CONTAINER".padEnd(32)} ${"PROFILE".padEnd(16)} ${"STATE".padEnd(10)} ${"IMAGE".padEnd(34)} WORKDIR`;
    console.log(chalk.bold(HEADER));
    console.log(chalk.dim("─".repeat(HEADER.length)));

    for (const c of containers) {
      const labels = parseLabels(c.Labels);
      const name = c.Names.replace(/^\//, "");
      const profile = labels["ccpod.profile"] ?? "-";
      const workdir = labels["ccpod.workdir"] ?? labels["ccpod.project"] ?? "-";
      const isRunning = c.Status.startsWith("Up");
      const stateRaw = isRunning ? "running" : "stopped";
      const stateColored = isRunning
        ? chalk.green(stateRaw)
        : chalk.yellow(stateRaw);
      const statePad = " ".repeat(Math.max(0, 10 - stateRaw.length));

      console.log(
        `${col(name, 32)} ${col(profile, 16)} ${stateColored}${statePad} ${col(c.Image, 34)} ${workdir}`,
      );
    }
  },
});
