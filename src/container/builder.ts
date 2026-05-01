import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import type { ResolvedConfig } from "../types/index.ts";

const CCPOD_DIR = join(homedir(), ".ccpod");

export interface ContainerSpec {
  image: string;
  name: string;
  workingDir: string;
  env: string[];
  binds: string[];
  volumes: Record<string, object>;
  portBindings: Record<string, Array<{ HostPort: string }>>;
  networkMode: string;
  tty: boolean;
  openStdin: boolean;
  labels: Record<string, string>;
  tmpfs?: Record<string, string>;
}

export function buildContainerSpec(
  config: ResolvedConfig,
  projectDir: string,
  tty: boolean,
): ContainerSpec {
  const projectHash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const credentialsDir = join(CCPOD_DIR, "credentials", config.profileName);

  const binds = [
    `${projectDir}:/workspace:rw`,
    `${config.mergedConfigDir}:/ccpod/config:ro`,
    `${credentialsDir}:/ccpod/credentials:rw`,
  ];

  if (config.ssh.mountSshDir) {
    binds.push(`${homedir()}/.ssh:/root/.ssh:ro`);
  }

  const volumes: Record<string, object> = {
    [`ccpod-plugins-${config.profileName}`]: {},
  };

  const tmpfs: Record<string, string> = {};

  if (config.state === "persistent") {
    volumes[`ccpod-state-${config.profileName}`] = {};
  } else {
    tmpfs["/ccpod/state"] = "rw,noexec,nosuid,size=256m";
  }

  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const { host, container } of config.ports) {
    portBindings[`${container}/tcp`] = [{ HostPort: String(host) }];
  }

  const env = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);
  env.push(`CCPOD_STATE=${config.state}`);

  if (config.ssh.agentForward && process.env.SSH_AUTH_SOCK) {
    env.push(`SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock`);
    binds.push(`${process.env.SSH_AUTH_SOCK}:/run/host-services/ssh-auth.sock:ro`);
  }

  return {
    image: config.image,
    name: `ccpod-${config.profileName}-${projectHash}`,
    workingDir: "/workspace",
    env,
    binds,
    volumes,
    portBindings,
    networkMode: "bridge",
    tty,
    openStdin: tty,
    labels: {
      "ccpod.profile": config.profileName,
      "ccpod.project": projectHash,
      "ccpod.type": "main",
      "ccpod.version": VERSION,
    },
    ...(Object.keys(tmpfs).length > 0 ? { tmpfs } : {}),
  };
}
