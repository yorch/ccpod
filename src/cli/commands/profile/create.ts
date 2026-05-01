import { defineCommand } from "citty";
import { runWizard } from "../../../init/wizard.ts";

export default defineCommand({
  meta: { description: "Create a new profile" },
  args: { name: { type: "positional", description: "Profile name" } },
  async run({ args }) {
    if (!args.name) throw new Error("Profile name required");
    await runWizard(args.name);
  },
});
