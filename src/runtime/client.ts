import type Dockerode from "dockerode";
import { detectRuntime } from "./detector.ts";

let _client: Dockerode | null = null;

export async function getDockerClient(): Promise<Dockerode> {
  if (!_client) {
    const { default: Docker } = await import("dockerode");
    const runtime = detectRuntime();
    _client = new Docker({ socketPath: runtime.socketPath });
  }
  return _client;
}
