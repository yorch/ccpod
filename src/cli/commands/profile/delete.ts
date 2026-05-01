import { defineCommand } from "citty";
import { deleteProfile } from "../../../profile/manager.ts";

export default defineCommand({
  meta: { description: "Delete a profile" },
  args: { name: { type: "positional", description: "Profile name" } },
  run({ args }) {
    if (!args.name) throw new Error("Profile name required");
    deleteProfile(args.name);
    console.log(`Profile '${args.name}' deleted.`);
  },
});
