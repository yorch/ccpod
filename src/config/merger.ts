import deepmerge from "deepmerge";
import type { ProfileConfig, ProjectConfig, ResolvedConfig } from "../types/index.ts";

export function mergeConfigs(
  profile: ProfileConfig,
  project: ProjectConfig | null,
  overrides: { state?: "ephemeral" | "persistent" } = {},
): Omit<ResolvedConfig, "mergedConfigDir" | "claudeArgs"> {
  const strategy = project?.merge ?? "deep";

  const network =
    strategy === "override" && project?.network
      ? { ...profile.network, ...project.network }
      : deepmerge(profile.network, project?.network ?? {});

  const ports = {
    list: [...(profile.ports.list ?? []), ...(project?.ports?.list ?? [])],
    autoDetectMcp: project?.ports?.autoDetectMcp ?? profile.ports.autoDetectMcp,
  };

  const services =
    strategy === "override" && project?.services
      ? project.services
      : { ...profile.services, ...(project?.services ?? {}) };

  const env = [...new Set([...profile.env, ...(project?.env ?? [])])];

  return {
    profileName: profile.name,
    image: profile.image.use === "build" ? "" : profile.image.use,
    dockerfile: profile.image.dockerfile,
    auth: profile.auth,
    state: overrides.state ?? profile.state,
    ssh: profile.ssh,
    network,
    ports: parsePorts(ports.list),
    services,
    env: {},
  };
}

function parsePorts(list: string[]): Array<{ host: number; container: number }> {
  return list.map((entry) => {
    const [hostStr = entry, containerStr = entry] = entry.split(":");
    return { host: Number(hostStr), container: Number(containerStr) };
  });
}

export function mergeClaudes(profileContent: string, projectContent: string, mode: "append" | "override"): string {
  if (mode === "override") return projectContent;
  return `${profileContent}\n\n---\n\n${projectContent}`;
}
