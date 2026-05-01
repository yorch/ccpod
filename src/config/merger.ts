import deepmerge from "deepmerge";
import type {
  ProfileConfig,
  ProjectConfig,
  ResolvedConfig,
} from "../types/index.ts";

export function mergeConfigs(
  profile: ProfileConfig,
  project: ProjectConfig | null,
  overrides: { state?: "ephemeral" | "persistent" } = {},
): Omit<ResolvedConfig, "mergedConfigDir" | "claudeArgs"> {
  const strategy = project?.merge ?? "deep";

  // override: project replaces the section using schema defaults for omitted keys,
  // NOT profile values — spreading from profile would leak profile's allow list.
  const NETWORK_DEFAULTS: ProfileConfig["network"] = {
    allow: [],
    policy: "full",
  };
  const network =
    strategy === "override" && project?.network
      ? { ...NETWORK_DEFAULTS, ...project.network }
      : deepmerge(profile.network, project?.network ?? {});

  const ports = {
    autoDetectMcp: project?.ports?.autoDetectMcp ?? profile.ports.autoDetectMcp,
    list: [...(profile.ports.list ?? []), ...(project?.ports?.list ?? [])],
  };

  const services =
    strategy === "override" && project?.services
      ? project.services
      : { ...profile.services, ...(project?.services ?? {}) };

  const _env = [...new Set([...profile.env, ...(project?.env ?? [])])];

  return {
    auth: profile.auth,
    autoDetectMcp: ports.autoDetectMcp,
    dockerfile: profile.image.dockerfile,
    env: {},
    image: profile.image.use,
    network,
    ports: parsePorts(ports.list),
    profileName: profile.name,
    services,
    ssh: profile.ssh,
    state: overrides.state ?? profile.state,
  };
}

function parsePorts(
  list: string[],
): Array<{ host: number; container: number }> {
  return list.map((entry) => {
    const [hostStr = entry, containerStr = entry] = entry.split(":");
    return { container: Number(containerStr), host: Number(hostStr) };
  });
}

export function mergeClaudes(
  profileContent: string,
  projectContent: string,
  mode: "append" | "override",
): string {
  if (mode === "override") return projectContent;
  return `${profileContent}\n\n---\n\n${projectContent}`;
}
