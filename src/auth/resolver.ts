import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { getCcpodHome } from '../profile/manager.ts';
import type { ProfileConfig } from '../types/index.ts';

export function resolveAuth(
  auth: ProfileConfig['auth'],
): Record<string, string> {
  if (auth.type === 'oauth') {
    // OAuth tokens live in the credentials dir, mounted by entrypoint
    return {};
  }

  const envVar = auth.keyEnv ?? 'ANTHROPIC_API_KEY';
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    return { ANTHROPIC_API_KEY: fromEnv };
  }

  if (auth.keyFile) {
    const keyPath = resolvePath(auth.keyFile.replace(/^~/, homedir()));
    // Schema already restricts auth.keyFile to "~/.ccpod/..." strings.
    // Resolve symlinks before reading so a symlink under ~/.ccpod that
    // targets /etc/shadow can't bypass the schema check.
    let realKeyPath: string;
    try {
      realKeyPath = realpathSync(keyPath);
    } catch {
      // File doesn't exist yet — warn and skip the keyFile path, matching the
      // historical behaviour for a missing file.
      console.warn(
        `Warning: ${envVar} not set and no keyFile found. Container may fail to authenticate.`,
      );
      return {};
    }
    const home = resolvePath(getCcpodHome());
    if (realKeyPath !== home && !realKeyPath.startsWith(`${home}/`)) {
      throw new Error(
        `auth.keyFile "${auth.keyFile}" resolves to ${realKeyPath}, outside ~/.ccpod. ` +
          'Refusing to read it — symlinks under ~/.ccpod cannot redirect to host paths.',
      );
    }
    return { ANTHROPIC_API_KEY: readFileSync(realKeyPath, 'utf8').trim() };
  }

  console.warn(
    `Warning: ${envVar} not set and no keyFile found. Container may fail to authenticate.`,
  );
  return {};
}

function interpolateHostEnv(
  value: string,
  context: { source: string },
  warned: Set<string>,
): string {
  // Local regex avoids shared `lastIndex` state. Names follow POSIX shell
  // identifier rules. Defaults are literal — no nested expansion. The `:-`
  // form falls back on both unset and empty values, matching POSIX semantics.
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
  return value.replace(re, (_match, name: string, def?: string) => {
    const hostValue = process.env[name];
    if (def !== undefined) {
      return hostValue !== undefined && hostValue !== '' ? hostValue : def;
    }
    if (hostValue !== undefined) {
      return hostValue;
    }
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(
        `Warning: ${context.source} references unset host variable \${${name}}; substituting empty string. Use \${${name}:-default} to silence.`,
      );
    }
    return '';
  });
}

// Env vars an untrusted project .ccpod.yml may not set (compared
// case-insensitively). These can redirect API traffic away from Anthropic —
// exfiltrating the profile's resolved credential — inject code into the
// credential-bearing Node process, or weaken TLS trust. The profile owner and
// --env can still set them; only project-sourced entries are blocked. (Egress
// is separately constrained by a `restricted` network policy; this list closes
// the in-process redirect/injection path.)
const PROJECT_ENV_DENYLIST = new Set([
  // Anthropic credential + endpoint redirection
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  // Proxy redirection (Node honors upper- and lower-case; matched via toUpperCase)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  // Code injection into the Node process
  'NODE_OPTIONS',
  // TLS-trust weakening (Node + non-Node MCP servers)
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
]);

export function resolveEnvForwarding(
  profileKeys: string[],
  projectKeys: string[],
  cliOverrides: string[],
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const warned = new Set<string>();

  const apply = (
    entries: string[],
    source: string,
    allowInterpolation: boolean,
  ) => {
    for (const entry of entries) {
      const eqIdx = entry.indexOf('=');
      const name = eqIdx !== -1 ? entry.slice(0, eqIdx) : entry;
      // Only project entries are untrusted; profile/CLI use interpolation.
      if (!allowInterpolation && PROJECT_ENV_DENYLIST.has(name.toUpperCase())) {
        console.warn(
          `Warning: project .ccpod.yml env entry '${name}' is not allowed ` +
            '(it could redirect API traffic or weaken TLS) — ignoring it.',
        );
        continue;
      }
      if (eqIdx !== -1) {
        const rawValue = entry.slice(eqIdx + 1);
        if (!allowInterpolation && /\$\{[A-Za-z_]/.test(rawValue)) {
          throw new Error(
            `${source} entry '${name}=…' uses \${VAR} interpolation, which is only allowed in profile or --env entries. Use a literal value or forward the variable bare.`,
          );
        }
        resolved[name] = allowInterpolation
          ? interpolateHostEnv(rawValue, { source }, warned)
          : rawValue;
      } else if (process.env[entry] !== undefined) {
        resolved[entry] = process.env[entry] ?? '';
      }
    }
  };

  apply(profileKeys, 'profile env', true);
  apply(projectKeys, 'project env', false);
  apply(cliOverrides, 'CLI --env', true);

  return resolved;
}
