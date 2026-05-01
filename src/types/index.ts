export type SyncStrategy = "always" | "daily" | "pin";
export type MergeStrategy = "deep" | "override";
export type StateMode = "ephemeral" | "persistent";
export type NetworkPolicy = "full" | "restricted";
export type AuthType = "api-key" | "oauth";
export type ClaudeMdMerge = "append" | "override";

export interface PortsConfig {
  list: string[];
  autoDetectMcp: boolean;
}

export interface ProfileConfig {
  name: string;
  description?: string;
  config: {
    source: "local" | "git";
    path?: string;
    repo?: string;
    sync?: SyncStrategy;
    ref?: string;
  };
  image: {
    use: string;
    dockerfile?: string;
  };
  auth: {
    type: AuthType;
    keyEnv?: string;
    keyFile?: string;
  };
  state: StateMode;
  ssh: {
    agentForward: boolean;
    mountSshDir: boolean;
  };
  network: {
    policy: NetworkPolicy;
    allow: string[];
  };
  ports: PortsConfig;
  services: Record<string, ServiceConfig>;
  env: string[];
}

export interface ProjectConfig {
  profile?: string;
  merge?: MergeStrategy;
  config?: {
    claudeMd?: ClaudeMdMerge;
  };
  network?: Partial<ProfileConfig["network"]>;
  ports?: Partial<PortsConfig>;
  services?: Record<string, ServiceConfig>;
  env?: string[];
}

export interface ServiceConfig {
  image: string;
  env?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
}

export interface PortMapping {
  host: number;
  container: number;
}

export interface ResolvedConfig {
  profileName: string;
  image: string;
  dockerfile?: string;
  auth: ProfileConfig["auth"];
  state: StateMode;
  ssh: ProfileConfig["ssh"];
  network: ProfileConfig["network"];
  ports: PortMapping[];
  autoDetectMcp: boolean;
  services: Record<string, ServiceConfig>;
  env: Record<string, string>;
  mergedConfigDir: string;
  claudeArgs: string[];
}

export interface DetectedRuntime {
  name: string;
  socketPath: string;
}

export interface PluginDiff {
  toInstall: string[];
  alreadyInstalled: string[];
  toRemove: string[];
}

export interface ContainerLabels {
  "ccpod.profile": string;
  "ccpod.project": string;
  "ccpod.type": "main" | string;
  "ccpod.version": string;
}
