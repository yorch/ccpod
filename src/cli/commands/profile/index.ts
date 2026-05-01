import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "Manage ccpod profiles" },
  subCommands: {
    create: () => import("./create.ts").then((m) => m.default),
    list: () => import("./list.ts").then((m) => m.default),
    update: () => import("./update.ts").then((m) => m.default),
    delete: () => import("./delete.ts").then((m) => m.default),
  },
});
