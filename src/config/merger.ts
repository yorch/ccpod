import deepmerge from 'deepmerge';
import type {
  ProfileConfig,
  ProjectConfig,
  ResolvedConfig,
  ServiceConfig,
} from '../types/index.ts';

function sanitizeProjectServices(
  services: Record<string, ServiceConfig>,
): Record<string, ServiceConfig> {
  const out: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(services)) {
    const volumes = (svc.volumes ?? []).map((v) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*:/.test(v)) {
        throw new Error(
          `Project service '${name}' volume '${v}' is not a named volume. ` +
            'Host-path mounts from project config require profile-level ' +
            'allowProjectHostMounts: true.',
        );
      }
      return v;
    });
    const ports = (svc.ports ?? []).map((p) => {
      const parts = p.split(':');
      if (parts.length >= 3) {
        const ip = parts[0];
        if (ip !== '127.0.0.1' && ip !== 'localhost') {
          throw new Error(
            `Project service '${name}' port '${p}' binds to ${ip || '0.0.0.0'}; ` +
              'only 127.0.0.1 is allowed without profile-level ' +
              'allowProjectHostMounts: true.',
          );
        }
        return p;
      }
      if (parts.length === 2) {
        return `127.0.0.1:${p}`;
      }
      return p;
    });
    out[name] = { ...svc, ports, volumes };
  }
  return out;
}

export function mergeConfigs(
  profile: ProfileConfig,
  project: ProjectConfig | null,
  overrides: { state?: 'ephemeral' | 'persistent' } = {},
): Omit<ResolvedConfig, 'mergedConfigDir'> {
  if (profile.isolation) {
    return {
      auth: profile.auth,
      autoDetectMcp: profile.ports.autoDetectMcp,
      claudeArgs: profile.claudeArgs,
      dockerfile: profile.image.dockerfile,
      env: {},
      image: profile.image.dockerfile ? 'build' : profile.image.use,
      init: profile.init,
      network: profile.network,
      plugins: profile.plugins,
      ports: parsePorts(profile.ports.list ?? []),
      profileName: profile.name,
      services: profile.services,
      ssh: profile.ssh,
      state: overrides.state ?? profile.state,
    };
  }

  const strategy = project?.merge ?? 'deep';

  // override: project replaces the section using schema defaults for omitted keys,
  // NOT profile values — spreading from profile would leak profile's allow list.
  const NETWORK_DEFAULTS: ProfileConfig['network'] = {
    allow: [],
    policy: 'full',
  };
  const network =
    strategy === 'override' && project?.network
      ? { ...NETWORK_DEFAULTS, ...project.network }
      : deepmerge(profile.network, project?.network ?? {});

  const ports = {
    autoDetectMcp: project?.ports?.autoDetectMcp ?? profile.ports.autoDetectMcp,
    list: [...(profile.ports.list ?? []), ...(project?.ports?.list ?? [])],
  };

  const projectServices = profile.allowProjectHostMounts
    ? (project?.services ?? {})
    : sanitizeProjectServices(project?.services ?? {});
  const services =
    strategy === 'override' && project?.services
      ? projectServices
      : { ...profile.services, ...projectServices };

  const claudeArgs =
    strategy === 'override'
      ? (project?.claudeArgs ?? [])
      : [...profile.claudeArgs, ...(project?.claudeArgs ?? [])];

  const projectInit = profile.allowProjectInit ? (project?.init ?? []) : [];
  if (!profile.allowProjectInit && project?.init && project.init.length > 0) {
    console.warn(
      'Warning: project .ccpod.yml declares init commands, but the active ' +
        'profile does not set allowProjectInit: true — ignoring them.',
    );
  }
  const init =
    strategy === 'override' ? projectInit : [...profile.init, ...projectInit];

  return {
    auth: profile.auth,
    autoDetectMcp: ports.autoDetectMcp,
    claudeArgs,
    dockerfile: profile.image.dockerfile,
    env: {},
    image: profile.image.dockerfile ? 'build' : profile.image.use,
    init,
    network,
    plugins: profile.plugins,
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
    const [hostStr = entry, containerStr = entry] = entry.split(':');
    const host = Number(hostStr);
    const container = Number(containerStr);
    if (
      !Number.isInteger(host) ||
      host <= 0 ||
      !Number.isInteger(container) ||
      container <= 0
    ) {
      throw new Error(
        `Invalid port mapping "${entry}": expected "host:container" with positive integers`,
      );
    }
    return { container, host };
  });
}

export function mergeClaudes(
  profileContent: string,
  projectContent: string,
  mode: 'append' | 'override',
): string {
  if (mode === 'override') {
    return projectContent;
  }
  return `${profileContent}\n\n---\n\n${projectContent}`;
}
