export type SyncStrategy = 'always' | 'daily' | 'pin';
type MergeStrategy = 'deep' | 'override';
type StateMode = 'ephemeral' | 'persistent';
type NetworkPolicy = 'full' | 'restricted';
type AuthType = 'api-key' | 'oauth';
type ClaudeMdMerge = 'append' | 'override';
export type PermissionsPreset = 'conservative' | 'moderate' | 'permissive';

interface PortsConfig {
  autoDetectMcp: boolean;
  list: string[];
}

export interface ProfileConfig {
  allowProjectHostMounts: boolean;
  allowProjectInit: boolean;
  auth: {
    type: AuthType;
    keyEnv?: string;
    keyFile?: string;
  };
  claudeArgs: string[];
  config: {
    source: 'local' | 'git';
    path?: string;
    repo?: string;
    sync?: SyncStrategy;
    ref?: string;
    overlay: boolean;
  };
  description?: string;
  env: string[];
  image: {
    use: string;
    dockerfile?: string;
  };
  init: string[];
  isolation: boolean;
  name: string;
  network: {
    policy: NetworkPolicy;
    allow: string[];
  };
  permissions?: PermissionsPreset;
  plugins: string[];
  ports: PortsConfig;
  services: Record<string, ServiceConfig>;
  ssh: {
    agentForward: boolean;
    mountSshDir: boolean;
  };
  state: StateMode;
}

export interface ProjectConfig {
  claudeArgs?: string[];
  config?: {
    claudeMd?: ClaudeMdMerge;
  };
  env?: string[];
  init?: string[];
  merge?: MergeStrategy;
  network?: Partial<ProfileConfig['network']>;
  ports?: Partial<PortsConfig>;
  profile?: string;
  services?: Record<string, ServiceConfig>;
}

export interface ServiceConfig {
  env?: Record<string, string>;
  image: string;
  ports?: string[];
  volumes?: string[];
}

interface PortMapping {
  container: number;
  host: number;
  // Host interface to bind the published port to. Undefined means Docker's
  // default (0.0.0.0). Ports sourced from untrusted project config are pinned
  // to '127.0.0.1' so a cloned repo cannot expose the container to the LAN.
  hostIp?: string;
}

export interface ResolvedConfig {
  auth: ProfileConfig['auth'];
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
}

export interface DetectedRuntime {
  name: string;
  socketPath: string;
}
