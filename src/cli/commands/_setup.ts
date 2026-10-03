import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { readHostOAuthCredentials } from '../../auth/keychain.ts';
import { resolveAuth, resolveEnvForwarding } from '../../auth/resolver.ts';
import { loadProfileConfig, loadProjectConfig } from '../../config/loader.ts';
import {
  mergeClaudes,
  mergeConfigs,
  mergeSettings,
} from '../../config/merger.ts';
import { expandPermissionsPreset } from '../../config/permissions.ts';
import { isRegularDir, writeMergedConfig } from '../../config/writer.ts';
import { computeProjectHash } from '../../container/builder.ts';
import { sidecarNetworkName, startSidecars } from '../../container/sidecars.ts';
import { computeLocalImageTag } from '../../image/hash.ts';
import { ensureImage, ensureLocalImage } from '../../image/manager.ts';
import { runWizard } from '../../init/wizard.ts';
import { extractHttpMcpPorts, parseMcpJson } from '../../mcp/parser.ts';
import { syncGitConfig } from '../../profile/git-sync.ts';
import {
  getCredentialsDir,
  getProfileDir,
  profileExists,
  resolveProfileDockerfile,
} from '../../profile/manager.ts';
import type { ResolvedConfig } from '../../types/index.ts';
import { ensureProjectProfileTrusted } from '../project-trust.ts';
import { validateProfileArg } from '../validate.ts';

interface ContainerSetupArgs {
  claudeArgs?: string[];
  envArgs?: string[];
  noState?: boolean;
  profile?: string;
  rebuild?: boolean;
  requireAuth?: boolean;
}

interface ContainerSetupResult {
  config: ResolvedConfig;
  networkName: string | undefined;
}

export async function setupContainer(
  args: ContainerSetupArgs,
  cwd: string,
): Promise<ContainerSetupResult> {
  validateProfileArg(args.profile);
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
      throw new Error(
        `Profile '${profileName}' not found. Run 'ccpod init --profile ${profileName}'.`,
      );
    }
  }

  // The project (untrusted) picked this profile rather than the user via
  // --profile: require remembered approval before honoring it.
  if (!args.profile && projectConfig?.profile && profileName !== 'default') {
    await ensureProjectProfileTrusted(cwd, profileName);
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
  // .mcp.json comes from the (untrusted) project checkout, so its auto-detected
  // ports are pinned to loopback — same treatment as project .ccpod.yml ports.
  const mcpPorts = mcpJson
    ? extractHttpMcpPorts(mcpJson).map((port) => ({
        container: port,
        host: port,
        hostIp: '127.0.0.1',
      }))
    : [];

  const authEnv = resolveAuth(profile.auth);

  if (args.requireAuth) {
    await assertHeadlessAuth(profile.auth, profileName, authEnv);
  }

  const env = {
    ...resolveEnvForwarding(
      profile.env,
      profile.isolation ? [] : (projectConfig?.env ?? []),
      args.envArgs ?? [],
      profile.allowProjectEnvForward,
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
    : readProjectFileIfExists(join(cwd, 'CLAUDE.md'));
  const claudeMdMode = profile.isolation
    ? 'append'
    : (projectConfig?.config?.claudeMd ?? 'append');
  const mergedClaudeMd =
    profileClaudeMd || projectClaudeMd
      ? mergeClaudes(profileClaudeMd ?? '', projectClaudeMd ?? '', claudeMdMode)
      : '';

  const projectClaudeDir = join(cwd, '.claude');
  // lstat of the file alone misses a symlinked .claude/ directory, so check
  // the directory too before trusting anything inside it.
  const projectSettings =
    profile.isolation || !isRegularDir(projectClaudeDir)
      ? {}
      : (readJsonIfExists(join(projectClaudeDir, 'settings.json'), true) ?? {});
  const mergedSettings = mergeSettings(
    expandPermissionsPreset(profile.permissions),
    readJsonIfExists(join(configSourceDir, 'settings.json')) ?? {},
    projectSettings,
  );
  const mergedConfigDir = writeMergedConfig(
    configSourceDir,
    mergedClaudeMd,
    mergedSettings,
    profile.isolation ? undefined : projectClaudeDir,
    partial.init,
  );

  console.log(chalk.dim('Checking image...'));
  const image = await resolveImage(partial, profileName, args.rebuild ?? false);

  const config: ResolvedConfig = {
    ...partial,
    claudeArgs: [...partial.claudeArgs, ...(args.claudeArgs ?? [])],
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

// Headless runs have no interactive prompt to recover from missing auth, so
// fail early with an actionable message instead of mid-run.
async function assertHeadlessAuth(
  auth: ResolvedConfig['auth'],
  profileName: string,
  authEnv: Record<string, string>,
): Promise<void> {
  if (auth.type === 'api-key' && Object.keys(authEnv).length === 0) {
    throw new Error(
      `Headless mode requires auth. Set ${auth.keyEnv ?? 'ANTHROPIC_API_KEY'} or configure keyFile.`,
    );
  }
  if (auth.type === 'oauth') {
    // The entrypoint copies ~/.claude/.credentials.json out of the credentials
    // bind mount at startup.
    const credPath = join(getCredentialsDir(profileName), '.credentials.json');
    if (!existsSync(credPath)) {
      throw new Error(
        `Headless mode with auth.type=oauth requires a prior interactive login. Run 'ccpod run' once to sign in, then re-run headlessly.`,
      );
    }
  }
  if (auth.type === 'proxy' && !readHostOAuthCredentials()) {
    // Proxy mode reads OAuth credentials from the host Keychain/file at start.
    throw new Error(
      `Headless mode with auth.type=proxy requires host OAuth credentials. Run 'claude /login' on the host first.`,
    );
  }
}

// Returns the image reference to run: the configured image, or a locally
// built tag when the profile points at a Dockerfile.
async function resolveImage(
  partial: Pick<ResolvedConfig, 'image' | 'dockerfile'>,
  profileName: string,
  rebuild: boolean,
): Promise<string> {
  if (partial.image !== 'build') {
    await ensureImage(partial.image, rebuild);
    return partial.image;
  }
  const dockerfileAbs = resolveProfileDockerfile(
    partial.dockerfile ?? 'Dockerfile',
    profileName,
  );
  const contextDir = dirname(dockerfileAbs);
  const tag = computeLocalImageTag(profileName, dockerfileAbs, contextDir);
  await ensureLocalImage(tag, dockerfileAbs, contextDir, rebuild);
  return tag;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// Project files come from an untrusted checkout. Refuse symlinks (and anything
// that isn't a regular file) so a repo can't point CLAUDE.md or
// .claude/settings.json at e.g. ~/.aws/credentials and have it spliced into the
// container's config — same rule as .mcp.json and .ccpod.yml.
function readProjectFileIfExists(path: string): string | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    console.warn(
      `Warning: ${path} is not a regular file (symlink?) — ignoring it.`,
    );
    return null;
  }
  return readFileSync(path, 'utf8');
}

function readJsonIfExists(path: string, untrusted = false): object | null {
  const raw = untrusted ? readProjectFileIfExists(path) : readIfExists(path);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as object;
  } catch {
    console.warn(`Warning: ${path} is not valid JSON — ignoring it.`);
    return null;
  }
}
