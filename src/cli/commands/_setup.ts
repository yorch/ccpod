import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import chalk from 'chalk';
import deepmerge from 'deepmerge';
import { resolveAuth, resolveEnvForwarding } from '../../auth/resolver.ts';
import { loadProfileConfig, loadProjectConfig } from '../../config/loader.ts';
import { mergeClaudes, mergeConfigs } from '../../config/merger.ts';
import { expandPermissionsPreset } from '../../config/permissions.ts';
import { writeMergedConfig } from '../../config/writer.ts';
import { computeProjectHash } from '../../container/builder.ts';
import { sidecarNetworkName, startSidecars } from '../../container/sidecars.ts';
import { computeDockerfileHash } from '../../image/hash.ts';
import { ensureImage, ensureLocalImage } from '../../image/manager.ts';
import { runWizard } from '../../init/wizard.ts';
import { extractHttpMcpPorts, parseMcpJson } from '../../mcp/parser.ts';
import { syncGitConfig } from '../../profile/git-sync.ts';
import { getProfileDir, profileExists } from '../../profile/manager.ts';
import type { ResolvedConfig } from '../../types/index.ts';

export interface ContainerSetupArgs {
  claudeArgs?: string[];
  envArgs?: string[];
  noState?: boolean;
  profile?: string;
  rebuild?: boolean;
  requireAuth?: boolean;
}

export interface ContainerSetupResult {
  config: ResolvedConfig;
  networkName: string | undefined;
}

export async function setupContainer(
  args: ContainerSetupArgs,
  cwd: string,
): Promise<ContainerSetupResult> {
  const projectConfig = loadProjectConfig(cwd);
  const explicitProfile = args.profile ?? projectConfig?.profile;
  const profileName = explicitProfile ?? 'default';

  if (!profileExists(profileName)) {
    if (!explicitProfile) {
      console.log(
        chalk.dim('No default profile found. Starting setup wizard...\n'),
      );
      await runWizard('default');
    } else {
      console.error(
        `${chalk.red('error:')} Profile '${profileName}' not found. Run 'ccpod init --profile ${profileName}'.`,
      );
      process.exit(1);
    }
  }

  const profileDir = getProfileDir(profileName);
  const profile = loadProfileConfig(profileDir);

  if (profile.config.source === 'git' && profile.config.repo) {
    await syncGitConfig(
      profileDir,
      profile.config.repo,
      profile.config.ref ?? 'main',
      profile.config.sync ?? 'daily',
    );
  }

  const stateOverride = args.noState ? ('ephemeral' as const) : undefined;
  const partial = mergeConfigs(profile, projectConfig, {
    state: stateOverride,
  });

  const mcpJson =
    partial.autoDetectMcp && !profile.isolation ? parseMcpJson(cwd) : null;
  const mcpPorts = mcpJson
    ? extractHttpMcpPorts(mcpJson).map((port) => ({
        container: port,
        host: port,
      }))
    : [];

  const authEnv = resolveAuth(profile.auth);

  if (
    args.requireAuth &&
    profile.auth.type === 'api-key' &&
    Object.keys(authEnv).length === 0
  ) {
    console.error(
      `${chalk.red('error:')} Headless mode requires auth. Set ${profile.auth.keyEnv ?? 'ANTHROPIC_API_KEY'} or configure keyFile.`,
    );
    process.exit(1);
  }

  const env = {
    ...resolveEnvForwarding(
      profile.env,
      profile.isolation ? [] : (projectConfig?.env ?? []),
      args.envArgs ?? [],
    ),
    ...authEnv,
  };

  const configSourceDir =
    profile.config.source === 'local'
      ? (profile.config.path ?? profileDir)
      : join(profileDir, 'config');

  const profileClaudeMd = readIfExists(join(configSourceDir, 'CLAUDE.md'));
  const projectClaudeMd = profile.isolation
    ? null
    : readIfExists(join(cwd, 'CLAUDE.md'));
  const claudeMdMode = profile.isolation
    ? 'append'
    : (projectConfig?.config?.claudeMd ?? 'append');
  const mergedClaudeMd =
    profileClaudeMd || projectClaudeMd
      ? mergeClaudes(profileClaudeMd ?? '', projectClaudeMd ?? '', claudeMdMode)
      : '';

  const presetSettings = expandPermissionsPreset(profile.permissions);
  const profileSettings = deepmerge(
    presetSettings,
    readJsonIfExists(join(configSourceDir, 'settings.json')) ?? {},
    {
      arrayMerge: (dest: unknown[], src: unknown[]) => {
        const combined = [...dest, ...src];
        return combined.every((item) => typeof item === 'string')
          ? [...new Set(combined as string[])]
          : combined;
      },
    },
  );
  const projectClaudeDir = join(cwd, '.claude');
  const projectSettings = profile.isolation
    ? {}
    : (readJsonIfExists(join(projectClaudeDir, 'settings.json')) ?? {});
  const mergedSettings = deepmerge(profileSettings, projectSettings, {
    arrayMerge: (dest: unknown[], src: unknown[]) => {
      const combined = [...dest, ...src];
      return combined.every((item) => typeof item === 'string')
        ? [...new Set(combined as string[])]
        : combined;
    },
  }) as object;
  const mergedConfigDir = writeMergedConfig(
    configSourceDir,
    mergedClaudeMd,
    mergedSettings,
    profile.isolation ? undefined : projectClaudeDir,
  );

  console.log(chalk.dim('Checking image...'));
  let image = partial.image;
  if (image === 'build') {
    const dockerfile = partial.dockerfile ?? 'Dockerfile';
    const dockerfileAbs = isAbsolute(dockerfile)
      ? dockerfile
      : join(cwd, dockerfile);
    const dockerfileHash = computeDockerfileHash(dockerfile, cwd);
    const tag = `ccpod-local-${profileName}-${dockerfileHash}:latest`;
    const contextDir = dirname(dockerfileAbs);
    await ensureLocalImage(
      tag,
      dockerfileAbs,
      contextDir,
      args.rebuild ?? false,
    );
    image = tag;
  } else {
    await ensureImage(image, args.rebuild ?? false);
  }

  const config: ResolvedConfig = {
    ...partial,
    claudeArgs: args.claudeArgs ?? partial.claudeArgs,
    env,
    image,
    mergedConfigDir,
    ports: [...partial.ports, ...mcpPorts],
  };

  const hash = computeProjectHash(cwd);
  let networkName: string | undefined;

  if (Object.keys(config.services).length > 0) {
    networkName = sidecarNetworkName(hash);
    console.log(chalk.bold('Starting sidecars...'));
    await startSidecars(config.services, networkName, profileName, hash);
  }

  return { config, networkName };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function readJsonIfExists(path: string): object | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as object;
  } catch {
    return null;
  }
}
