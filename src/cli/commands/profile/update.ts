import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "Force-pull git-based profile config" },
  args: { name: { type: "positional", description: "Profile name" } },
  run({ args }) {
    console.log(`ccpod profile update ${args.name} — not yet implemented`);
  },
});
