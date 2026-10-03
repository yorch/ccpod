import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntime } from '../../../src/runtime/detector.ts';

const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  for (const k of Object.keys(savedEnv)) {
    delete savedEnv[k];
  }
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs.length = 0;
});

function saveEnv(...keys: string[]) {
  for (const k of keys) {
    savedEnv[k] = process.env[k];
  }
}

function makeFakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccpod-home-'));
  tempDirs.push(dir);
  return dir;
}

function touchFile(path: string): void {
  mkdirSync(path.substring(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, '');
}

beforeEach(() => {
  // A developer's real DOCKER_HOST must not leak into detection tests.
  saveEnv('DOCKER_HOST');
  delete process.env.DOCKER_HOST;
});

describe('detectRuntime', () => {
  it('detects OrbStack when its socket exists', () => {
    saveEnv('HOME');
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, '.orbstack/run/docker.sock'));

    const result = detectRuntime();
    expect(result.name).toBe('orbstack');
    expect(result.socketPath).toBe(join(home, '.orbstack/run/docker.sock'));
  });

  it('prefers OrbStack over Docker when both sockets present', () => {
    saveEnv('HOME');
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, '.orbstack/run/docker.sock'));
    touchFile(join(home, '.docker/run/docker.sock'));

    expect(detectRuntime().name).toBe('orbstack');
  });

  it('detects Docker via home-based socket', () => {
    saveEnv('HOME');
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, '.docker/run/docker.sock'));

    // OrbStack socket absent in fake home; result is docker (may use /var/run/docker.sock or home path)
    expect(detectRuntime().name).toBe('docker');
  });

  it('detects Colima when its socket exists and Docker absent', () => {
    saveEnv('HOME', 'DOCKER_SOCKET_PATH');
    const home = makeFakeHome();
    process.env.HOME = home;
    process.env.DOCKER_SOCKET_PATH = join(home, 'nonexistent-docker.sock');
    touchFile(join(home, '.colima/default/docker.sock'));

    expect(detectRuntime().name).toBe('colima');
  });

  it('detects Podman via XDG_RUNTIME_DIR socket', () => {
    saveEnv('HOME', 'XDG_RUNTIME_DIR', 'DOCKER_SOCKET_PATH');
    const home = makeFakeHome();
    const xdg = makeFakeHome();
    process.env.HOME = home;
    process.env.XDG_RUNTIME_DIR = xdg;
    process.env.DOCKER_SOCKET_PATH = join(home, 'nonexistent-docker.sock');
    touchFile(join(xdg, 'podman/podman.sock'));

    const result = detectRuntime();
    expect(result.name).toBe('podman');
    expect(result.socketPath).toBe(join(xdg, 'podman/podman.sock'));
  });

  it('throws descriptive error when no sockets exist', () => {
    saveEnv('HOME', 'XDG_RUNTIME_DIR', 'DOCKER_SOCKET_PATH');
    const home = makeFakeHome();
    process.env.HOME = home;
    process.env.XDG_RUNTIME_DIR = home;
    process.env.DOCKER_SOCKET_PATH = join(home, 'nonexistent-docker.sock');

    expect(() => detectRuntime()).toThrow('No container runtime detected');
  });
});

describe('detectRuntime — DOCKER_HOST', () => {
  it('honors a remote DOCKER_HOST as-is', () => {
    saveEnv('HOME');
    process.env.HOME = makeFakeHome();
    process.env.DOCKER_HOST = 'tcp://build-box:2376';
    const result = detectRuntime();
    expect(result.dockerHost).toBe('tcp://build-box:2376');
    expect(result.name).toBe('docker');
  });

  it('honors an existing unix:// DOCKER_HOST over other sockets', () => {
    saveEnv('HOME');
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, '.orbstack/run/docker.sock'));
    const custom = join(home, 'custom.sock');
    touchFile(custom);
    process.env.DOCKER_HOST = `unix://${custom}`;
    expect(detectRuntime().socketPath).toBe(custom);
  });

  it('ignores a stale unix:// DOCKER_HOST and auto-detects', () => {
    saveEnv('HOME');
    const home = makeFakeHome();
    process.env.HOME = home;
    touchFile(join(home, '.orbstack/run/docker.sock'));
    process.env.DOCKER_HOST = 'unix:///nonexistent/docker.sock';
    const result = detectRuntime();
    expect(result.name).toBe('orbstack');
    expect(result.dockerHost).toBeUndefined();
  });

  it('detects rootless Docker under XDG_RUNTIME_DIR', () => {
    saveEnv('HOME', 'XDG_RUNTIME_DIR', 'DOCKER_SOCKET_PATH');
    process.env.HOME = makeFakeHome();
    const xdg = makeFakeHome();
    process.env.XDG_RUNTIME_DIR = xdg;
    process.env.DOCKER_SOCKET_PATH = join(xdg, 'no-such.sock');
    touchFile(join(xdg, 'docker.sock'));
    const result = detectRuntime();
    expect(result.name).toBe('docker');
    expect(result.socketPath).toBe(join(xdg, 'docker.sock'));
  });
});
