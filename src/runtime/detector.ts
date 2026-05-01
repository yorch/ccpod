import { existsSync } from "node:fs";
import type { DetectedRuntime } from "../types/index.ts";

export function detectRuntime(): DetectedRuntime {
  const home = process.env.HOME ?? "";
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR ?? "";

  const candidates = [
    {
      name: "orbstack",
      sockets: [`${home}/.orbstack/run/docker.sock`],
    },
    {
      name: "docker",
      sockets: ["/var/run/docker.sock", `${home}/.docker/run/docker.sock`],
    },
    {
      name: "colima",
      sockets: [
        `${home}/.colima/default/docker.sock`,
        `${home}/.colima/docker.sock`,
      ],
    },
    {
      name: "podman",
      sockets: [
        `${xdgRuntimeDir}/podman/podman.sock`,
        `${home}/.local/share/containers/podman/machine/podman.sock`,
      ],
    },
  ];

  for (const candidate of candidates) {
    for (const socket of candidate.sockets) {
      if (socket && existsSync(socket)) {
        return { name: candidate.name, socketPath: socket };
      }
    }
  }
  throw new Error(
    "No container runtime detected. Install Docker, OrbStack, Colima, or Podman.",
  );
}
