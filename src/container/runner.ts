import { dockerExec, dockerSpawn } from "../runtime/docker.ts";
import type { ContainerSpec } from "./builder.ts";

export async function runContainer(spec: ContainerSpec): Promise<number> {
  const state = await containerState(spec.name);

  if (state === "running") {
    console.log(`Reattaching to running container: ${spec.name}`);
    return dockerSpawn(["attach", spec.name]);
  }

  if (state === "stopped") {
    await dockerExec(["rm", spec.name]);
  }

  return dockerSpawn(buildRunArgs(spec));
}

export async function stopContainer(name: string): Promise<void> {
  const state = await containerState(name);
  if (state === "not_found") return;
  if (state === "running") await dockerExec(["stop", "-t", "5", name]);
  await dockerExec(["rm", name]);
}

async function containerState(name: string): Promise<"running" | "stopped" | "not_found"> {
  const { exitCode, stdout } = await dockerExec(["inspect", "--format", "{{.State.Status}}", name]);
  if (exitCode !== 0) return "not_found";
  return stdout === "running" ? "running" : "stopped";
}

function buildRunArgs(spec: ContainerSpec): string[] {
  const args: string[] = ["run"];

  if (spec.tty) args.push("-it");

  args.push("--name", spec.name, "-w", spec.workingDir);

  for (const e of spec.env) args.push("-e", e);
  for (const b of spec.binds) args.push("-v", b);

  for (const [key, val] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${val}`);
  }

  for (const [containerPort, bindings] of Object.entries(spec.portBindings)) {
    for (const hb of bindings) {
      args.push("-p", `${hb.HostPort}:${containerPort.replace("/tcp", "")}`);
    }
  }

  if (spec.networkMode && spec.networkMode !== "bridge") {
    args.push("--network", spec.networkMode);
  }

  for (const [path, opts] of Object.entries(spec.tmpfs ?? {})) {
    args.push("--tmpfs", `${path}:${opts}`);
  }

  args.push(spec.image);

  if (spec.cmd && spec.cmd.length > 0) args.push(...spec.cmd);

  return args;
}
