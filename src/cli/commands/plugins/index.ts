import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "Manage Claude Code plugins for a profile" },
  subCommands: {
    list: () => import("./list.ts").then((m) => m.default),
    update: () => import("./update.ts").then((m) => m.default),
  },
});
