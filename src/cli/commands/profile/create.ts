import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "Create a new profile" },
  args: { name: { type: "positional", description: "Profile name" } },
  run({ args }) {
    console.log(`ccpod profile create ${args.name} — not yet implemented`);
  },
});
