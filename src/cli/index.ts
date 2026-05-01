import { defineCommand, runMain } from "citty";
import { VERSION } from "../version.ts";

const main = defineCommand({
  meta: {
    name: "ccpod",
    version: VERSION,
    description: "Run Claude Code in Docker containers with portable, composable configuration",
  },
  subCommands: {
    run: () => import("./commands/run.ts").then((m) => m.default),
    init: () => import("./commands/init.ts").then((m) => m.default),
    profile: () => import("./commands/profile/index.ts").then((m) => m.default),
    plugins: () => import("./commands/plugins/index.ts").then((m) => m.default),
    image: () => import("./commands/image/index.ts").then((m) => m.default),
    state: () => import("./commands/state/index.ts").then((m) => m.default),
    config: () => import("./commands/config/index.ts").then((m) => m.default),
    ps: () => import("./commands/ps.ts").then((m) => m.default),
    down: () => import("./commands/down.ts").then((m) => m.default),
  },
});

runMain(main);
