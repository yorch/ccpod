import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { buildContainerSpec } from "../../../src/container/builder.ts";
import type { ResolvedConfig } from "../../../src/types/index.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    profileName: "testprof",
    image: "ghcr.io/ccpod/base:latest",
    auth: { type: "api-key", keyEnv: "ANTHROPIC_API_KEY" },
    state: "ephemeral",
    ssh: { agentForward: false, mountSshDir: false },
    network: { policy: "full", allow: [] },
    ports: [],
    autoDetectMcp: true,
    services: {},
    env: {},
    mergedConfigDir: "/tmp/ccpod-config-abc",
    claudeArgs: [],
    ...overrides,
  };
}

const PROJECT_DIR = "/home/user/my-project";
const PROJECT_HASH = createHash("sha256").update(PROJECT_DIR).digest("hex").slice(0, 16);

describe("buildContainerSpec", () => {
  it("produces deterministic container name from profile + project hash", () => {
    const spec = buildContainerSpec(makeConfig(), PROJECT_DIR, true);
    expect(spec.name).toBe(`ccpod-testprof-${PROJECT_HASH}`);
  });

  it("includes workspace, config, and credentials binds", () => {
    const spec = buildContainerSpec(makeConfig(), PROJECT_DIR, true);
    expect(spec.binds.some((b) => b.startsWith(`${PROJECT_DIR}:/workspace:rw`))).toBe(true);
    expect(spec.binds.some((b) => b.includes(":/ccpod/config:ro"))).toBe(true);
    expect(spec.binds.some((b) => b.includes(":/ccpod/credentials:rw"))).toBe(true);
  });

  it("includes plugins named volume in binds", () => {
    const spec = buildContainerSpec(makeConfig(), PROJECT_DIR, true);
    expect(spec.binds).toContain("ccpod-plugins-testprof:/ccpod/plugins");
  });

  it("ephemeral state: tmpfs mounted, no state volume in binds", () => {
    const spec = buildContainerSpec(makeConfig({ state: "ephemeral" }), PROJECT_DIR, true);
    expect(spec.tmpfs?.["/ccpod/state"]).toBeDefined();
    expect(spec.binds.some((b) => b.includes("ccpod-state-"))).toBe(false);
  });

  it("persistent state: named volume in binds, no tmpfs", () => {
    const spec = buildContainerSpec(makeConfig({ state: "persistent" }), PROJECT_DIR, true);
    expect(spec.binds).toContain("ccpod-state-testprof:/ccpod/state");
    expect(spec.tmpfs?.["/ccpod/state"]).toBeUndefined();
  });

  it("SSH dir mount when mountSshDir=true", () => {
    const spec = buildContainerSpec(
      makeConfig({ ssh: { agentForward: false, mountSshDir: true } }),
      PROJECT_DIR,
      true,
    );
    expect(spec.binds.some((b) => b.includes("/.ssh:/root/.ssh:ro"))).toBe(true);
  });

  it("no SSH dir bind when mountSshDir=false", () => {
    const spec = buildContainerSpec(makeConfig(), PROJECT_DIR, true);
    expect(spec.binds.some((b) => b.includes("/.ssh:"))).toBe(false);
  });

  it("port bindings map host to container", () => {
    const spec = buildContainerSpec(
      makeConfig({ ports: [{ host: 3000, container: 3001 }] }),
      PROJECT_DIR,
      true,
    );
    expect(spec.portBindings["3001/tcp"]).toEqual([{ HostPort: "3000" }]);
  });

  it("env always contains CCPOD_STATE", () => {
    const spec = buildContainerSpec(makeConfig(), PROJECT_DIR, true);
    expect(spec.env).toContain("CCPOD_STATE=ephemeral");
  });

  it("env includes resolved key=value pairs", () => {
    const spec = buildContainerSpec(
      makeConfig({ env: { ANTHROPIC_API_KEY: "sk-abc", FOO: "bar" } }),
      PROJECT_DIR,
      true,
    );
    expect(spec.env).toContain("ANTHROPIC_API_KEY=sk-abc");
    expect(spec.env).toContain("FOO=bar");
  });

  it("labels include all required keys", () => {
    const spec = buildContainerSpec(makeConfig(), PROJECT_DIR, true);
    expect(spec.labels["ccpod.profile"]).toBe("testprof");
    expect(spec.labels["ccpod.project"]).toBe(PROJECT_HASH);
    expect(spec.labels["ccpod.workdir"]).toBe(PROJECT_DIR);
    expect(spec.labels["ccpod.type"]).toBe("main");
    expect(spec.labels["ccpod.version"]).toBeTruthy();
  });

  it("tty=false sets openStdin=false", () => {
    const spec = buildContainerSpec(makeConfig(), PROJECT_DIR, false);
    expect(spec.tty).toBe(false);
    expect(spec.openStdin).toBe(false);
  });

  it("image passes through from config", () => {
    const spec = buildContainerSpec(makeConfig({ image: "my-custom:1.2.3" }), PROJECT_DIR, true);
    expect(spec.image).toBe("my-custom:1.2.3");
  });
});
