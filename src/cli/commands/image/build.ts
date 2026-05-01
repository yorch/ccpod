import chalk from "chalk";
import { defineCommand } from "citty";
import {
  loadProfileConfig,
  loadProjectConfig,
} from "../../../config/loader.ts";
import { buildImage } from "../../../image/manager.ts";
import { getProfileDir, profileExists } from "../../../profile/manager.ts";

export default defineCommand({
  args: {
    dockerfile: {
      description: "Dockerfile path (overrides profile)",
      type: "string",
    },
    profile: { description: "Profile name", type: "string" },
    tag: {
      description: "Image tag (overrides auto-generated)",
      type: "string",
    },
  },
  meta: { description: "Build a local Docker image for a profile" },
  async run({ args }) {
    const projectConfig = loadProjectConfig(process.cwd());
    const profileName = args.profile ?? projectConfig?.profile ?? "default";

    if (!profileExists(profileName)) {
      console.error(`Profile '${profileName}' not found.`);
      process.exit(1);
    }

    const profile = loadProfileConfig(getProfileDir(profileName));
    const dockerfile =
      args.dockerfile ?? profile.image.dockerfile ?? "Dockerfile";
    const tag = args.tag ?? `ccpod-local-${profileName}:latest`;

    console.log(chalk.dim(`Building ${dockerfile} → ${tag}`));
    await buildImage(dockerfile, tag, process.cwd());
    console.log(chalk.green(`\n✓ Built: ${tag}`));
    console.log(
      chalk.dim(`Update profile image.use to '${tag}' to use this image.`),
    );
  },
});
