import { explainProjectEnvEntry } from '../auth/resolver.ts';
import type { ProfileConfig, ProjectConfig } from '../types/index.ts';

export function redactLiteral(_value: string): string {
  return '<redacted>';
}

export function redactServiceEnv<T extends Record<string, unknown>>(
  services: T,
): T {
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => {
      if (!service || typeof service !== 'object') {
        return [name, service];
      }
      const value = service as Record<string, unknown>;
      const env = value.env;
      return [
        name,
        {
          ...value,
          ...(env && typeof env === 'object'
            ? {
                env: Object.fromEntries(
                  Object.entries(env).map(([key, literal]) => [
                    key,
                    typeof literal === 'string'
                      ? redactLiteral(literal)
                      : literal,
                  ]),
                ),
              }
            : {}),
        },
      ];
    }),
  ) as T;
}

export function explainConfig(
  profile: ProfileConfig,
  project: ProjectConfig | null,
) {
  const projectApplied = !profile.isolation && project !== null;
  const ignored: Array<{ path: string; reason: string }> = [];
  const errors: Array<{ path: string; reason: string }> = [];
  if (profile.isolation && project) {
    ignored.push({
      path: '.ccpod.yml',
      reason: 'profile isolation disables project config',
    });
  } else if (project) {
    if (project.network && Object.keys(project.network).length) {
      ignored.push({
        path: 'project.network',
        reason: 'network policy is profile-owned',
      });
    }
    if (project.init?.length && !profile.allowProjectInit) {
      ignored.push({
        path: 'project.init',
        reason: 'profile allowProjectInit is false',
      });
    }
    if (
      project.services &&
      Object.keys(project.services).length &&
      !profile.allowProjectServices
    ) {
      ignored.push({
        path: 'project.services',
        reason: 'profile allowProjectServices is false',
      });
    }
    for (const [index, entry] of (project.env ?? []).entries()) {
      const decision = explainProjectEnvEntry(
        entry,
        profile.allowProjectEnvForward,
      );
      if (!decision.eligible) {
        const item = {
          path: `project.env[${index}] (${decision.name})`,
          reason: decision.reason,
        };
        if (decision.disposition === 'rejected') {
          errors.push(item);
        } else {
          ignored.push(item);
        }
      }
    }
  }

  const projectServicesApply =
    projectApplied &&
    profile.allowProjectServices &&
    Object.keys(project?.services ?? {}).length > 0;
  const projectInitApplies =
    projectApplied && profile.allowProjectInit && project?.init !== undefined;
  const sources = {
    allowProject: 'profile',
    auth: 'profile',
    autoDetectMcp:
      projectApplied && project?.ports?.autoDetectMcp !== undefined
        ? 'project'
        : 'profile',
    claudeArgs:
      projectApplied && project?.claudeArgs !== undefined
        ? project?.merge === 'override'
          ? 'project (override)'
          : 'profile + project'
        : projectApplied && project?.merge === 'override'
          ? 'project (empty override)'
          : 'profile',
    env: 'profile entries, then eligible project entries (values never resolved)',
    image: 'profile',
    init:
      projectApplied && project?.merge === 'override'
        ? projectInitApplies && project?.init?.length
          ? 'project (override)'
          : 'project (empty override)'
        : projectInitApplies && project?.init?.length
          ? 'profile + project'
          : 'profile',
    isolation: 'profile',
    network: 'profile (project values ignored)',
    permissions: 'profile',
    plugins: 'profile',
    ports:
      projectApplied && project?.ports?.list?.length
        ? 'profile + loopback-only project ports'
        : 'profile',
    profile: 'selected profile directory',
    services: projectServicesApply
      ? project?.merge === 'override'
        ? 'project (override)'
        : 'profile + permitted project services'
      : 'profile',
    ssh: 'profile',
    state: 'profile',
    stateIsolation: 'profile',
  };
  return { errors, ignored, sources };
}
