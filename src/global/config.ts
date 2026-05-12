import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { z } from 'zod';
import { getCcpodHome } from '../profile/manager.ts';

const GlobalConfigSchema = z
  .object({
    autoCheckUpdates: z.boolean().default(true),
  })
  .default({ autoCheckUpdates: true });

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

function globalConfigPath(): string {
  return join(getCcpodHome(), 'config.yml');
}

export function loadGlobalConfig(): GlobalConfig {
  const path = globalConfigPath();
  if (!existsSync(path)) {
    return GlobalConfigSchema.parse({});
  }
  try {
    return GlobalConfigSchema.parse(yamlParse(readFileSync(path, 'utf8')));
  } catch {
    return GlobalConfigSchema.parse({});
  }
}

export function saveGlobalConfig(config: GlobalConfig): void {
  const path = globalConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(config), 'utf8');
}
