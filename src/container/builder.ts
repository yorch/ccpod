import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { getCredentialsDir } from "../profile/manager.ts";
import type { ResolvedConfig } from "../types/index.ts";
import { VERSION } from "../version.ts";

export interface ContainerSpec {
  binds: string[];
  cmd?: string[];
  env: string[];
  image: string;
  labels: Record<string, string>;
  name: string;
  networkMode: string;
  openStdin: boolean;
  portBindings: Record<string, Array<{ HostPort: string }>>;
  tmpfs?: Record<string, string>;
  tty: boolean;
  workingDir: string;
}

export function buildContainerSpec(
  config: ResolvedConfig,
  projectDir: string,
  tty: boolean,
): ContainerSpec {
  const projectHash = createHash("sha256")
    .update(projectDir)
    .digest("hex")
    .slice(0, 16);
  const credentialsDir = getCredentialsDir(config.profileName);

  const binds = [
    `${projectDir}:/workspace:rw`,
    `${config.mergedConfigDir}:/ccpod/config:ro`,
    `${credentialsDir}:/ccpod/credentials:rw`,
  ];

  if (config.ssh.mountSshDir) {
    binds.push(`${homedir()}/.ssh:/root/.ssh:ro`);
  }

  // Named volumes - Docker accepts `volumeName:/path` in Binds
  binds.push(`ccpod-plugins-${config.profileName}:/ccpod/plugins`);
  if (config.state === "persistent") {
    binds.push(`ccpod-state-${config.profileName}:/ccpod/state`);
  }

  const tmpfs: Record<string, string> = {};
  if (config.state === "ephemeral") {
    tmpfs["/ccpod/state"] = "rw,noexec,nosuid,size=256m";
  }

  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const { host, container } of config.ports) {
    portBindings[`${container}/tcp`] = [{ HostPort: String(host) }];
  }

  const env = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);
  env.push(`CCPOD_STATE=${config.state}`);

  if (config.ssh.agentForward && process.env.SSH_AUTH_SOCK) {
    const sshSock = process.env.SSH_AUTH_SOCK;
    if (!sshSock.includes(":")) {
      env.push(`SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock`);
      binds.push(`${sshSock}:/run/host-services/ssh-auth.sock:ro`);
    }
  }

  return {
    binds,
    env,
    image: config.image,
    labels: {
      "ccpod.profile": config.profileName,
      "ccpod.project": projectHash,
      "ccpod.type": "main",
      "ccpod.version": VERSION,
      "ccpod.workdir": projectDir,
    },
    name: `ccpod-${config.profileName}-${projectHash}`,
    networkMode: "bridge",
    openStdin: tty,
    portBindings,
    tty,
    workingDir: "/workspace",
    ...(Object.keys(tmpfs).length > 0 ? { tmpfs } : {}),
    ...(config.claudeArgs.length > 0 ? { cmd: config.claudeArgs } : {}),
  };
}
