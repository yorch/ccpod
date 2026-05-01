import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockDockerExec = mock(
  async (_args: string[]) =>
    ({ exitCode: 0, stderr: "", stdout: "" }) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    },
);
const mockDockerSpawn = mock(async (_args: string[]) => 0 as number);

mock.module("../../../src/runtime/docker.ts", () => ({
  dockerExec: mockDockerExec,
  dockerSpawn: mockDockerSpawn,
}));

import type { ContainerSpec } from "../../../src/container/builder.ts";
import { runContainer } from "../../../src/container/runner.ts";

function makeSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    binds: ["/proj:/workspace:rw"],
    env: ["ANTHROPIC_API_KEY=test"],
    image: "test-image:latest",
    labels: { "ccpod.profile": "default" },
    name: "ccpod-default-abc123",
    networkMode: "bridge",
    openStdin: true,
    portBindings: {},
    tty: true,
    workingDir: "/workspace",
    ...overrides,
  };
}

beforeEach(() => {
  mockDockerExec.mockReset();
  mockDockerExec.mockImplementation(async () => ({
    exitCode: 0,
    stderr: "",
    stdout: "",
  }));
  mockDockerSpawn.mockReset();
  mockDockerSpawn.mockImplementation(async () => 0);
});

describe("runContainer", () => {
  it("starts a new container when not found", async () => {
    // inspect: container not found
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 1,
      stderr: "Error: No such container",
      stdout: "",
    }));

    const code = await runContainer(makeSpec());

    expect(code).toBe(0);
    expect(mockDockerSpawn).toHaveBeenCalledTimes(1);
    const spawnArgs = mockDockerSpawn.mock.calls[0][0] as string[];
    expect(spawnArgs[0]).toBe("run");
    expect(spawnArgs).toContain("test-image:latest");
  });

  it("reattaches when container is already running", async () => {
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "running",
    }));

    await runContainer(makeSpec());

    const spawnArgs = mockDockerSpawn.mock.calls[0][0] as string[];
    expect(spawnArgs[0]).toBe("attach");
    // rm must NOT be called
    const execArgs = mockDockerExec.mock.calls.map((c) => c[0] as string[]);
    expect(execArgs.some((a) => a.includes("rm"))).toBe(false);
  });

  it("removes stopped container then starts fresh", async () => {
    // inspect: stopped
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "exited",
    }));
    // rm: success
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));

    await runContainer(makeSpec());

    const execArgs = mockDockerExec.mock.calls.map((c) => c[0] as string[]);
    expect(execArgs.some((a) => a.includes("rm"))).toBe(true);
    const spawnArgs = mockDockerSpawn.mock.calls[0][0] as string[];
    expect(spawnArgs[0]).toBe("run");
  });

  it("throws when docker rm fails on a stopped container", async () => {
    // inspect: stopped
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "exited",
    }));
    // rm: fails
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 1,
      stderr: "permission denied",
      stdout: "",
    }));

    await expect(runContainer(makeSpec())).rejects.toThrow(
      "Failed to remove stopped container",
    );
    expect(mockDockerSpawn).not.toHaveBeenCalled();
  });

  it("passes --name, -w, and image to docker run args", async () => {
    // inspect: not found
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 1,
      stderr: "",
      stdout: "",
    }));

    await runContainer(makeSpec({ image: "my-img:v1", name: "my-container" }));

    const spawnArgs = mockDockerSpawn.mock.calls[0][0] as string[];
    expect(spawnArgs).toContain("--name");
    expect(spawnArgs).toContain("my-container");
    expect(spawnArgs).toContain("-w");
    expect(spawnArgs).toContain("/workspace");
    expect(spawnArgs).toContain("my-img:v1");
  });

  it("appends cmd to run args when spec.cmd is set", async () => {
    mockDockerExec.mockImplementationOnce(async () => ({
      exitCode: 1,
      stderr: "",
      stdout: "",
    }));

    await runContainer(makeSpec({ cmd: ["--file", "/workspace/prompt.md"] }));

    const spawnArgs = mockDockerSpawn.mock.calls[0][0] as string[];
    expect(spawnArgs).toContain("--file");
    expect(spawnArgs).toContain("/workspace/prompt.md");
  });
});
