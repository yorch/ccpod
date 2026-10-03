import type { z } from 'zod';
import type {
  profileConfigSchema,
  projectConfigSchema,
  serviceConfigSchema,
} from '../config/schema.ts';

export type SyncStrategy = 'always' | 'daily' | 'pin';
type StateMode = 'ephemeral' | 'persistent';
type StateIsolation = 'per-profile' | 'per-project';
export type PermissionsPreset = 'conservative' | 'moderate' | 'permissive';

// Derived from the Zod schemas so the types cannot drift from validation.
export type ProfileConfig = z.output<typeof profileConfigSchema>;
// What a project .ccpod.yml may contain. The input type is used so callers can
// build one without spelling out schema defaults; parsed output is assignable.
export type ProjectConfig = z.input<typeof projectConfigSchema>;
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

// Auth as carried on ResolvedConfig: the schema applies a keyEnv default, but
// resolved/test configs may omit it.
type AuthConfig = Pick<ProfileConfig['auth'], 'type'> &
  Partial<Pick<ProfileConfig['auth'], 'keyEnv' | 'keyFile'>>;

interface PortMapping {
  container: number;
  host: number;
  // Host interface to bind the published port to. Undefined means Docker's
  // default (0.0.0.0). Ports sourced from untrusted project config are pinned
  // to '127.0.0.1' so a cloned repo cannot expose the container to the LAN.
  hostIp?: string;
}

export interface ResolvedConfig {
  auth: AuthConfig;
  autoDetectMcp: boolean;
  claudeArgs: string[];
  dockerfile?: string;
  env: Record<string, string>;
  image: string;
  init: string[];
  mergedConfigDir: string;
  network: ProfileConfig['network'];
  plugins: string[];
  ports: PortMapping[];
  profileName: string;
  services: Record<string, ServiceConfig>;
  ssh: ProfileConfig['ssh'];
  state: StateMode;
  stateIsolation: StateIsolation;
}

export interface DetectedRuntime {
  // Value for DOCKER_HOST when the user's own DOCKER_HOST was honored
  // (including remote tcp:// / ssh:// hosts); otherwise derived from socketPath.
  dockerHost?: string;
  name: string;
  socketPath: string;
}
