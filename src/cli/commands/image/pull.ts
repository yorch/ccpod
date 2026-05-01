import chalk from "chalk";
import { defineCommand } from "citty";
import {
  loadProfileConfig,
  loadProjectConfig,
} from "../../../config/loader.ts";
import { ensureImage } from "../../../image/manager.ts";
import { getProfileDir, profileExists } from "../../../profile/manager.ts";

export default defineCommand({
  meta: { description: "Pull the Docker image for a profile" },
  args: {
    profile: { type: "string", description: "Profile name" },
    force: {
      type: "boolean",
      description: "Force re-pull even if image exists",
      default: false,
    },
  },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? "default";

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    const profile = loadProfileConfig(getProfileDir(profileName));
    const image = profile.image.use;

    if (image === "build") {
      console.error(
        `Profile '${profileName}' uses a local build (image.use=build). Use 'ccpod image build' instead.`,
      );
      process.exit(1);
    }

    await ensureImage(image, args.force ?? false);
    console.log(chalk.green(`\n✓ Image ready: ${image}`));
  },
});
