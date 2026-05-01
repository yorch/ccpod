import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime } from "../../../src/runtime/detector.ts";

const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
});

function saveEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

function makeFakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccpod-home-"));
  tempDirs.push(dir);
  return dir;
}

function touchFile(path: string): void {
  mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, "");
}

describe("detectRuntime", () => {
  it("detects OrbStack when its socket exists", () => {
    saveEnv("HOME");
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, ".orbstack/run/docker.sock"));

    const result = detectRuntime();
    expect(result.name).toBe("orbstack");
    expect(result.socketPath).toBe(join(home, ".orbstack/run/docker.sock"));
  });

  it("prefers OrbStack over Docker when both sockets present", () => {
    saveEnv("HOME");
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, ".orbstack/run/docker.sock"));
    touchFile(join(home, ".docker/run/docker.sock"));

    expect(detectRuntime().name).toBe("orbstack");
  });

  it("detects Docker via home-based socket", () => {
    saveEnv("HOME");
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, ".docker/run/docker.sock"));

    // OrbStack socket absent in fake home; result is docker (may use /var/run/docker.sock or home path)
    expect(detectRuntime().name).toBe("docker");
  });

  it("detects Colima when its socket exists and Docker absent", () => {
    if (existsSync("/var/run/docker.sock")) return; // absolute path we can't suppress
    saveEnv("HOME");
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, ".colima/default/docker.sock"));

    expect(detectRuntime().name).toBe("colima");
  });

  it("detects Podman via XDG_RUNTIME_DIR socket", () => {
    if (existsSync("/var/run/docker.sock")) return;
    saveEnv("HOME", "XDG_RUNTIME_DIR");
    const home = makeFakeHome();
    const xdg = makeFakeHome();
    process.env.HOME = home;
    process.env.XDG_RUNTIME_DIR = xdg;
    touchFile(join(xdg, "podman/podman.sock"));

    const result = detectRuntime();
    expect(result.name).toBe("podman");
    expect(result.socketPath).toBe(join(xdg, "podman/podman.sock"));
  });

  it("throws descriptive error when no sockets exist", () => {
    if (existsSync("/var/run/docker.sock")) return;
    saveEnv("HOME", "XDG_RUNTIME_DIR");
    const home = makeFakeHome();
    process.env.HOME = home;
    process.env.XDG_RUNTIME_DIR = home;

    expect(() => detectRuntime()).toThrow("No container runtime detected");
  });
});
