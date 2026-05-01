import chalk from "chalk";
import { defineCommand, runMain } from "citty";
import { VERSION } from "../version.ts";

function handleFatalError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${chalk.red("error:")} ${msg}\n`);
  process.exit(1);
}

process.on("unhandledRejection", handleFatalError);
process.on("uncaughtException", handleFatalError);

const main = defineCommand({
  meta: {
    description:
      "Run Claude Code in Docker containers with portable, composable configuration",
    name: "ccpod",
    version: VERSION,
  },
  subCommands: {
    config: () => import("./commands/config/index.ts").then((m) => m.default),
    down: () => import("./commands/down.ts").then((m) => m.default),
    image: () => import("./commands/image/index.ts").then((m) => m.default),
    init: () => import("./commands/init.ts").then((m) => m.default),
    plugins: () => import("./commands/plugins/index.ts").then((m) => m.default),
    profile: () => import("./commands/profile/index.ts").then((m) => m.default),
    ps: () => import("./commands/ps.ts").then((m) => m.default),
    run: () => import("./commands/run.ts").then((m) => m.default),
    state: () => import("./commands/state/index.ts").then((m) => m.default),
  },
});

runMain(main);
