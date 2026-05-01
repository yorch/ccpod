import { defineCommand } from "citty";
import { runWizard } from "../../init/wizard.ts";

export default defineCommand({
  meta: { description: "Interactive first-run setup wizard" },
  args: {
    profile: {
      type: "string",
      description: "Profile name to create",
      default: "default",
    },
  },
  async run({ args }) {
    await runWizard(args.profile ?? "default");
  },
});
