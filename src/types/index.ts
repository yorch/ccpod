export type SyncStrategy = "always" | "daily" | "pin";
export type MergeStrategy = "deep" | "override";
export type StateMode = "ephemeral" | "persistent";
export type NetworkPolicy = "full" | "restricted";
export type AuthType = "api-key" | "oauth";
export type ClaudeMdMerge = "append" | "override";

export interface PortsConfig {
  autoDetectMcp: boolean;
  list: string[];
}

export interface ProfileConfig {
  auth: {
    type: AuthType;
    keyEnv?: string;
    keyFile?: string;
  };
  config: {
    source: "local" | "git";
    path?: string;
    repo?: string;
    sync?: SyncStrategy;
    ref?: string;
  };
  description?: string;
  env: string[];
  image: {
    use: string;
    dockerfile?: string;
  };
  name: string;
  network: {
    policy: NetworkPolicy;
    allow: string[];
  };
  ports: PortsConfig;
  services: Record<string, ServiceConfig>;
  ssh: {
    agentForward: boolean;
    mountSshDir: boolean;
  };
  state: StateMode;
}

export interface ProjectConfig {
  config?: {
    claudeMd?: ClaudeMdMerge;
  };
  env?: string[];
  merge?: MergeStrategy;
  network?: Partial<ProfileConfig["network"]>;
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

export interface PortMapping {
  container: number;
  host: number;
}

export interface ResolvedConfig {
  auth: ProfileConfig["auth"];
  autoDetectMcp: boolean;
  claudeArgs: string[];
  dockerfile?: string;
  env: Record<string, string>;
  image: string;
  mergedConfigDir: string;
  network: ProfileConfig["network"];
  ports: PortMapping[];
  profileName: string;
  services: Record<string, ServiceConfig>;
  ssh: ProfileConfig["ssh"];
  state: StateMode;
}

export interface DetectedRuntime {
  name: string;
  socketPath: string;
}

export interface ContainerLabels {
  "ccpod.profile": string;
  "ccpod.project": string;
  "ccpod.type": "main" | string;
  "ccpod.version": string;
  "ccpod.workdir": string;
}
