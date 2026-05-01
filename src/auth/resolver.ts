import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ProfileConfig } from "../types/index.ts";

export function resolveAuth(
  auth: ProfileConfig["auth"],
): Record<string, string> {
  if (auth.type === "oauth") {
    // OAuth tokens live in the credentials dir, mounted by entrypoint
    return {};
  }

  const envVar = auth.keyEnv ?? "ANTHROPIC_API_KEY";
  const fromEnv = process.env[envVar];
  if (fromEnv) return { ANTHROPIC_API_KEY: fromEnv };

  if (auth.keyFile) {
    const keyPath = auth.keyFile.replace(/^~/, homedir());
    if (existsSync(keyPath)) {
      return { ANTHROPIC_API_KEY: readFileSync(keyPath, "utf8").trim() };
    }
  }

  console.warn(
    `Warning: ${envVar} not set and no keyFile found. Container may fail to authenticate.`,
  );
  return {};
}

export function resolveEnvForwarding(
  profileKeys: string[],
  projectKeys: string[],
  cliOverrides: string[],
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const key of [...profileKeys, ...projectKeys]) {
    const eqIdx = key.indexOf("=");
    if (eqIdx !== -1) {
      resolved[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
    } else if (process.env[key] !== undefined) {
      resolved[key] = process.env[key] ?? "";
    }
  }

  for (const override of cliOverrides) {
    const eqIdx = override.indexOf("=");
    if (eqIdx !== -1) {
      resolved[override.slice(0, eqIdx)] = override.slice(eqIdx + 1);
    }
  }

  return resolved;
}
