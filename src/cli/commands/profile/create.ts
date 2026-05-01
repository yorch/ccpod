import { defineCommand } from "citty";
import { runWizard } from "../../../init/wizard.ts";

export default defineCommand({
  args: { name: { description: "Profile name", type: "positional" } },
  meta: { description: "Create a new profile" },
  async run({ args }) {
    if (!args.name) throw new Error("Profile name required");
    await runWizard(args.name);
  },
});
