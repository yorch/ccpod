import Dockerode from "dockerode";
import { detectRuntime } from "./detector.ts";

let _client: Dockerode | null = null;

export function getDockerClient(): Dockerode {
  if (!_client) {
    const runtime = detectRuntime();
    _client = new Dockerode({ socketPath: runtime.socketPath });
  }
  return _client;
}
