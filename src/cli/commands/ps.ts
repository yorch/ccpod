import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "List running ccpod containers" },
  run() {
    // TODO: docker ps --filter label=ccpod.profile
    console.log("ccpod ps — not yet implemented");
  },
});
