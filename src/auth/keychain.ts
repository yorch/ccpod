import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Claude Code's OAuth credential keychain service name (macOS).
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT =
  process.env.USER ?? homedir().split('/').pop() ?? 'user';

// The credential file path used on Linux/Windows (no Keychain).
const CREDENTIAL_FILE = join(homedir(), '.claude', '.credentials.json');

export function hostOAuthCredentialLockScope(): string {
  // Keychain reads may fall back from an account-specific lookup to any item
  // under this service, so requested accounts must share one lock scope.
  if (process.platform === 'darwin') {
    return `keychain:${KEYCHAIN_SERVICE}`;
  }
  return `file:${CREDENTIAL_FILE}`;
}

export type OAuthCredentialStoreIdentity =
  | { kind: 'file' }
  | { account: string; kind: 'keychain' };

export interface OAuthCredentialEntry {
  credentials: OAuthCredentials;
  identity?: OAuthCredentialStoreIdentity;
}

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
  return readHostOAuthCredentialEntry()?.credentials;
}

/** Read credentials and the exact store item that supplied them. */
export function readHostOAuthCredentialEntry(
  identity?: OAuthCredentialStoreIdentity,
): OAuthCredentialEntry | undefined {
  if (process.platform === 'darwin') {
    return readFromKeychainEntry(identity);
  }
  if (identity && identity.kind !== 'file') {
    return undefined;
  }
  const credentials = readFromCredentialFile();
  return credentials ? { credentials, identity: { kind: 'file' } } : undefined;
}

/**
 * Raw credential JSON from the host store (Keychain entry on macOS,
 * ~/.claude/.credentials.json elsewhere), or undefined when absent/invalid.
 * For callers that copy the credentials verbatim rather than parse them.
 */
export function readHostCredentialJsonRaw(): string | undefined {
  const raw =
    process.platform === 'darwin'
      ? readFromKeychainEntry()?.raw
      : readCredentialFileRaw();
  return raw && parseCredentialJson(raw) ? raw : undefined;
}

/**
 * Write OAuth credentials back to the host's credential store.
 * Used by the proxy to persist refreshed tokens.
 */
export function writeHostOAuthCredentials(creds: OAuthCredentials): void {
  if (process.platform === 'darwin') {
    writeToKeychain(creds, KEYCHAIN_ACCOUNT);
  } else {
    writeToCredentialFile(creds);
  }
}

/** Persist to the same store item selected by readHostOAuthCredentialEntry. */
export function writeHostOAuthCredentialEntry(
  creds: OAuthCredentials,
  identity: OAuthCredentialStoreIdentity,
): void {
  if (identity.kind === 'keychain' && process.platform === 'darwin') {
    writeToKeychain(creds, identity.account);
    return;
  }
  if (identity.kind === 'file' && process.platform !== 'darwin') {
    writeToCredentialFile(creds);
    return;
  }
  throw new Error(
    'OAuth credential store identity does not match this platform',
  );
}

function readFromKeychainEntry(
  identity?: OAuthCredentialStoreIdentity,
): (OAuthCredentialEntry & { raw: string }) | undefined {
  if (identity && identity.kind !== 'keychain') {
    return undefined;
  }
  if (identity?.kind === 'keychain') {
    const raw = readFromKeychainRaw(identity.account);
    const credentials = raw ? parseCredentialJson(raw) : undefined;
    return raw && credentials ? { credentials, identity, raw } : undefined;
  }

  const requestedAccount = KEYCHAIN_ACCOUNT;
  const requested = requestedAccount
    ? readFromKeychainRaw(requestedAccount)
    : undefined;
  const requestedCredentials = requested
    ? parseCredentialJson(requested)
    : undefined;
  if (requestedAccount && requested && requestedCredentials) {
    return {
      credentials: requestedCredentials,
      identity: { account: requestedAccount, kind: 'keychain' },
      raw: requested,
    };
  }

  // Discover only the selected item's attributes; deliberately omit -w/-g so
  // the Keychain command never returns the password/token. Then read by the
  // proven account to bind the secret and its identity to the same item.
  const fallbackAccount = readServiceFallbackAccount();
  if (!fallbackAccount) {
    return undefined;
  }
  const raw = readFromKeychainRaw(fallbackAccount);
  const credentials = raw ? parseCredentialJson(raw) : undefined;
  return raw && credentials
    ? {
        credentials,
        identity: { account: fallbackAccount, kind: 'keychain' },
        raw,
      }
    : undefined;
}

function readServiceFallbackAccount(): string | undefined {
  try {
    const attributes = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    const accounts = [...attributes.matchAll(/"acct"<blob>="([^"]+)"/g)].map(
      (match) => match[1],
    );
    return accounts.length === 1 && accounts[0] ? accounts[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a Keychain item's raw JSON by its proven account. When no explicit
 * account is requested, select the service fallback only after identifying its
 * account from metadata output that does not include the password.
 */
function readFromKeychainRaw(account?: string): string | undefined {
  const tryRead = (args: string[]): string | undefined => {
    try {
      return execFileSync('security', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      return undefined;
    }
  };

  // Try with -a <account> first, but only accept it if it parses as valid
  // credential JSON. Fall back to no -a if the -a result is missing or
  // corrupted (e.g. a stale keychain entry from a previous version).
  const selectedAccount = account ?? KEYCHAIN_ACCOUNT;
  if (selectedAccount) {
    const withAccount = tryRead([
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      selectedAccount,
      '-w',
    ]);
    if (withAccount && parseCredentialJson(withAccount)) {
      return withAccount;
    }
  }
  if (account !== undefined) {
    return undefined;
  }
  const fallbackAccount = readServiceFallbackAccount();
  return fallbackAccount ? readFromKeychainRaw(fallbackAccount) : undefined;
}

function writeToKeychain(creds: OAuthCredentials, account: string): void {
  // mergeCredentialJson re-reads the raw Keychain JSON to preserve
  // top-level keys (e.g. mcpOAuth). Falls back to a fresh wrap if the
  // Keychain entry doesn't exist or can't be parsed.
  const fullJson = mergeCredentialJson(creds, account);

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
        account,
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

function readCredentialFileRaw(): string | undefined {
  if (!existsSync(CREDENTIAL_FILE)) {
    return undefined;
  }
  try {
    return readFileSync(CREDENTIAL_FILE, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function readFromCredentialFile(): OAuthCredentials | undefined {
  const raw = readCredentialFileRaw();
  return raw ? parseCredentialJson(raw) : undefined;
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
  writeCredentialFileAtomically(CREDENTIAL_FILE, fullJson);
}

/**
 * Stage credential JSON in a private sibling directory and atomically rename
 * it over the destination. A failed/partial write never truncates the current
 * refresh-token generation.
 */
export function writeCredentialFileAtomically(
  path: string,
  fullJson: string,
  io: {
    rename: typeof renameSync;
    write: (
      path: string,
      data: string,
      options: { flag: 'wx'; mode: number },
    ) => void;
  } = { rename: renameSync, write: writeFileSync },
): void {
  try {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error('OAuth credential file is not a regular file');
    }
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }

  const parent = dirname(path);
  const stageDir = mkdtempSync(join(parent, '.ccpod-credentials-'));
  const stagePath = join(stageDir, 'credentials.json');
  try {
    io.write(stagePath, fullJson, { flag: 'wx', mode: 0o600 });
    chmodSync(stagePath, 0o600);
    io.rename(stagePath, path);
  } finally {
    rmSync(stageDir, { force: true, recursive: true });
  }
}

// -- JSON parsing helpers --

function parseCredentialJson(raw: string): OAuthCredentials | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)) {
      return undefined;
    }
    const fields = oauth as Record<string, unknown>;
    const { accessToken, expiresAt, refreshToken } = fields;
    if (
      typeof accessToken !== 'string' ||
      accessToken.length === 0 ||
      typeof refreshToken !== 'string' ||
      refreshToken.length === 0 ||
      typeof expiresAt !== 'number' ||
      !Number.isFinite(expiresAt) ||
      (fields.refreshTokenExpiresAt !== undefined &&
        (typeof fields.refreshTokenExpiresAt !== 'number' ||
          !Number.isFinite(fields.refreshTokenExpiresAt))) ||
      (fields.scopes !== undefined &&
        (!Array.isArray(fields.scopes) ||
          !fields.scopes.every((scope) => typeof scope === 'string'))) ||
      (fields.subscriptionType !== undefined &&
        typeof fields.subscriptionType !== 'string') ||
      (fields.rateLimitTier !== undefined &&
        typeof fields.rateLimitTier !== 'string')
    ) {
      return undefined;
    }
    return {
      accessToken,
      expiresAt,
      refreshToken,
      ...(fields.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: fields.refreshTokenExpiresAt }
        : {}),
      ...(fields.scopes !== undefined ? { scopes: fields.scopes } : {}),
      ...(fields.subscriptionType !== undefined
        ? { subscriptionType: fields.subscriptionType }
        : {}),
      ...(fields.rateLimitTier !== undefined
        ? { rateLimitTier: fields.rateLimitTier }
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

function mergeCredentialJson(
  updated: OAuthCredentials,
  keychainAccount?: string,
): string {
  // Preserve mcpOAuth and other top-level keys by rereading the exact selected
  // Keychain item when its account identity is known.
  let raw: string | undefined;
  if (process.platform === 'darwin') {
    raw = readFromKeychainRaw(keychainAccount);
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
