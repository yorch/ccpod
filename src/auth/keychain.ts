import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code's OAuth credential keychain service name (macOS).
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT =
  process.env.USER ?? homedir().split('/').pop() ?? 'user';

// The credential file path used on Linux/Windows (no Keychain).
const CREDENTIAL_FILE = join(homedir(), '.claude', '.credentials.json');

export interface OAuthCredentials {
  accessToken: string;
  expiresAt: number; // epoch ms
  rateLimitTier?: string;
  refreshToken: string;
  refreshTokenExpiresAt?: number; // epoch ms
  scopes?: string[];
  subscriptionType?: string;
}

/**
 * Read OAuth credentials from the host's credential store.
 *
 * On macOS: reads from the system Keychain via `security` CLI.
 * On Linux/Windows: reads from ~/.claude/.credentials.json.
 *
 * Returns undefined if no credentials are found.
 */
export function readHostOAuthCredentials(): OAuthCredentials | undefined {
  if (process.platform === 'darwin') {
    return readFromKeychain();
  }
  return readFromCredentialFile();
}

/**
 * Write OAuth credentials back to the host's credential store.
 * Used by the proxy to persist refreshed tokens.
 */
export function writeHostOAuthCredentials(creds: OAuthCredentials): void {
  if (process.platform === 'darwin') {
    writeToKeychain(creds);
  } else {
    writeToCredentialFile(creds);
  }
}

function readFromKeychain(): OAuthCredentials | undefined {
  try {
    const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'];
    // Include the account name if known — claude stores its entry with -a
    // <username>, and omitting -a when multiple entries exist under the same
    // service causes `security` to error with "SecKeychainItemCopyContent".
    if (KEYCHAIN_ACCOUNT) {
      args.push('-a', KEYCHAIN_ACCOUNT);
    }
    const raw = execFileSync('security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();

    return parseCredentialJson(raw);
  } catch {
    // Keychain entry not found or access denied
    return undefined;
  }
}

function writeToKeychain(creds: OAuthCredentials): void {
  // mergeCredentialJson re-reads the raw Keychain JSON to preserve
  // top-level keys (e.g. mcpOAuth). Falls back to a fresh wrap if the
  // Keychain entry doesn't exist or can't be parsed.
  const fullJson = mergeCredentialJson(creds);

  // Use -U (update if exists) to avoid duplicate entries.
  // NOTE: the `security` CLI does not support reading the password from
  // stdin, so the credential JSON is passed as argv. This briefly exposes
  // the tokens in `ps` / `/proc/<pid>/cmdline` for the lifetime of the
  // process (typically <100ms). This is a limitation of the `security` CLI
  // itself; a native Keychain binding would avoid it.
  try {
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-U',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-w',
        fullJson,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
    );
  } catch (err) {
    throw new Error(
      `Failed to write OAuth credentials to Keychain: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readFromCredentialFile(): OAuthCredentials | undefined {
  if (!existsSync(CREDENTIAL_FILE)) {
    return undefined;
  }
  try {
    const raw = readFileSync(CREDENTIAL_FILE, 'utf8').trim();
    return parseCredentialJson(raw);
  } catch {
    return undefined;
  }
}

function writeToCredentialFile(creds: OAuthCredentials): void {
  const fullJson = mergeCredentialJson(creds);

  const dir = join(homedir(), '.claude');
  if (!existsSync(dir)) {
    // Can't create ~/.claude — it's the host's Claude dir, not ours
    throw new Error(
      `Cannot write credentials: ${dir} does not exist. Run 'claude /login' first.`,
    );
  }
  writeFileSync(CREDENTIAL_FILE, fullJson, { mode: 0o600 });
  chmodSync(CREDENTIAL_FILE, 0o600);
}

// -- JSON parsing helpers --

function parseCredentialJson(raw: string): OAuthCredentials | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
    if (!oauth) {
      return undefined;
    }
    const accessToken = oauth.accessToken as string | undefined;
    const refreshToken = oauth.refreshToken as string | undefined;
    if (!accessToken || !refreshToken) {
      return undefined;
    }
    return {
      accessToken,
      expiresAt: oauth.expiresAt as number,
      refreshToken,
      ...(oauth.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt as number }
        : {}),
      ...(oauth.scopes !== undefined
        ? { scopes: oauth.scopes as string[] }
        : {}),
      ...(oauth.subscriptionType !== undefined
        ? { subscriptionType: oauth.subscriptionType as string }
        : {}),
      ...(oauth.rateLimitTier !== undefined
        ? { rateLimitTier: oauth.rateLimitTier as string }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function wrapInClaudeAiOauth(creds: OAuthCredentials): string {
  const oauth: Record<string, unknown> = {
    accessToken: creds.accessToken,
    expiresAt: creds.expiresAt,
    refreshToken: creds.refreshToken,
  };
  if (creds.refreshTokenExpiresAt !== undefined) {
    oauth.refreshTokenExpiresAt = creds.refreshTokenExpiresAt;
  }
  if (creds.scopes !== undefined) {
    oauth.scopes = creds.scopes;
  }
  if (creds.subscriptionType !== undefined) {
    oauth.subscriptionType = creds.subscriptionType;
  }
  if (creds.rateLimitTier !== undefined) {
    oauth.rateLimitTier = creds.rateLimitTier;
  }
  return JSON.stringify({ claudeAiOauth: oauth });
}

function mergeCredentialJson(updated: OAuthCredentials): string {
  // Preserve mcpOAuth and other top-level keys by re-reading the raw JSON
  let raw: string | undefined;
  if (process.platform === 'darwin') {
    try {
      const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'];
      if (KEYCHAIN_ACCOUNT) {
        args.push('-a', KEYCHAIN_ACCOUNT);
      }
      raw = execFileSync('security', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      // fall through
    }
  } else if (existsSync(CREDENTIAL_FILE)) {
    try {
      raw = readFileSync(CREDENTIAL_FILE, 'utf8').trim();
    } catch {
      // fall through
    }
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const existingOauth = parsed.claudeAiOauth as
        | Record<string, unknown>
        | undefined;
      parsed.claudeAiOauth = {
        ...(existingOauth ?? {}),
        accessToken: updated.accessToken,
        expiresAt: updated.expiresAt,
        refreshToken: updated.refreshToken,
        ...(updated.refreshTokenExpiresAt !== undefined
          ? { refreshTokenExpiresAt: updated.refreshTokenExpiresAt }
          : {}),
      };
      return JSON.stringify(parsed);
    } catch {
      // fall through to simple wrap
    }
  }

  return wrapInClaudeAiOauth(updated);
}
