import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { ProfileConfig } from '../types/index.ts';

function ccpodHome(): string {
  // CCPOD_TEST_DIR mirrors the test-override pattern in src/profile/manager.ts
  // so unit tests can point auth resolution at a temp directory without
  // polluting the developer's real ~/.ccpod.
  return resolvePath(process.env.CCPOD_TEST_DIR ?? join(homedir(), '.ccpod'));
}

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
    const home = ccpodHome();
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
  // identifier rules. Defaults are literal — no nested expansion.
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
  return value.replace(re, (_match, name: string, def?: string) => {
    const hostValue = process.env[name];
    if (hostValue !== undefined) {
      return hostValue;
    }
    if (def !== undefined) {
      return def;
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
      if (eqIdx !== -1) {
        const name = entry.slice(0, eqIdx);
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
