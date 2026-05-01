import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "Run Claude Code in a container (interactive or headless)" },
  args: {
    profile: { type: "string", description: "Profile name (overrides .ccpod.yml)" },
    env: { type: "string", description: "Pass/override env var (KEY=VALUE)", array: true },
    rebuild: { type: "boolean", description: "Force image rebuild", default: false },
    "no-state": { type: "boolean", description: "Force ephemeral state for this run", default: false },
    file: { type: "string", description: "Headless mode: read prompt from file" },
  },
  run({ args }) {
    // TODO: implement
    console.log("ccpod run — not yet implemented", args);
  },
});
