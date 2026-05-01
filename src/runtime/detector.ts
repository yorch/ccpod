import { existsSync } from "node:fs";
import type { DetectedRuntime } from "../types/index.ts";

const HOME = process.env.HOME ?? "";
const XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? "";

const RUNTIME_CANDIDATES: Array<{ name: string; sockets: string[] }> = [
  {
    name: "orbstack",
    sockets: [`${HOME}/.orbstack/run/docker.sock`],
  },
  {
    name: "docker",
    sockets: [
      "/var/run/docker.sock",
      `${HOME}/.docker/run/docker.sock`,
    ],
  },
  {
    name: "colima",
    sockets: [
      `${HOME}/.colima/default/docker.sock`,
      `${HOME}/.colima/docker.sock`,
    ],
  },
  {
    name: "podman",
    sockets: [
      `${XDG_RUNTIME_DIR}/podman/podman.sock`,
      `${HOME}/.local/share/containers/podman/machine/podman.sock`,
    ],
  },
];

export function detectRuntime(): DetectedRuntime {
  for (const candidate of RUNTIME_CANDIDATES) {
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
