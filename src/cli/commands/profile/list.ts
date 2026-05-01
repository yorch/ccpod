import { defineCommand } from "citty";
import { listProfiles } from "../../../profile/manager.ts";

export default defineCommand({
  meta: { description: "List all profiles" },
  run() {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log("No profiles found. Run `ccpod init` to create one.");
      return;
    }
    for (const p of profiles) console.log(p);
  },
});
