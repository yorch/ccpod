import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "Stop Claude container and all sidecars for current project" },
  run() {
    // TODO: docker ps --filter label=ccpod.project=<sha256(PWD)>, stop all
    console.log("ccpod down — not yet implemented");
  },
});
