import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ContainerSpec } from "../../../src/container/builder.ts";
import type { RunnerDeps } from "../../../src/container/runner.ts";
import { runContainer } from "../../../src/container/runner.ts";

type ExecResult = { exitCode: number; stdout: string; stderr: string };

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

function makeDeps(
  execResults: ExecResult[] = [],
  spawnResult = 0,
): {
  deps: RunnerDeps;
  execMock: ReturnType<typeof mock>;
  spawnMock: ReturnType<typeof mock>;
} {
  let execCallIndex = 0;
  const execMock = mock(async (_args: string[]): Promise<ExecResult> => {
    const result = execResults[execCallIndex] ?? {
      exitCode: 0,
      stderr: "",
      stdout: "",
    };
    execCallIndex++;
    return result;
  });
  const spawnMock = mock(
    async (_args: string[]): Promise<number> => spawnResult,
  );
  return {
    deps: {
      dockerExec: execMock as RunnerDeps["dockerExec"],
      dockerSpawn: spawnMock as RunnerDeps["dockerSpawn"],
    },
    execMock,
    spawnMock,
  };
}

describe("runContainer", () => {
  it("starts a new container when not found", async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: "Error: No such container", stdout: "" },
    ]);

    const code = await runContainer(makeSpec(), deps);

    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe("run");
    expect(spawnArgs).toContain("test-image:latest");
  });

  it("reattaches when container is already running", async () => {
    const { deps, spawnMock, execMock } = makeDeps([
      { exitCode: 0, stderr: "", stdout: "running" },
    ]);

    await runContainer(makeSpec(), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe("attach");
    const execArgs = (execMock.mock.calls as [string[]][]).map((c) => c[0]);
    expect(execArgs.some((a) => a.includes("rm"))).toBe(false);
  });

  it("removes stopped container then starts fresh", async () => {
    const { deps, spawnMock, execMock } = makeDeps([
      { exitCode: 0, stderr: "", stdout: "exited" },
      { exitCode: 0, stderr: "", stdout: "" },
    ]);

    await runContainer(makeSpec(), deps);

    const execArgs = (execMock.mock.calls as [string[]][]).map((c) => c[0]);
    expect(execArgs.some((a) => a.includes("rm"))).toBe(true);
    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe("run");
  });

  it("throws when docker rm fails on a stopped container", async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: "", stdout: "exited" },
      { exitCode: 1, stderr: "permission denied", stdout: "" },
    ]);

    await expect(runContainer(makeSpec(), deps)).rejects.toThrow(
      "Failed to remove stopped container",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("passes --name, -w, and image to docker run args", async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: "", stdout: "" },
    ]);

    await runContainer(
      makeSpec({ image: "my-img:v1", name: "my-container" }),
      deps,
    );

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs).toContain("--name");
    expect(spawnArgs).toContain("my-container");
    expect(spawnArgs).toContain("-w");
    expect(spawnArgs).toContain("/workspace");
    expect(spawnArgs).toContain("my-img:v1");
  });

  it("appends cmd to run args when spec.cmd is set", async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: "", stdout: "" },
    ]);

    await runContainer(
      makeSpec({ cmd: ["--file", "/workspace/prompt.md"] }),
      deps,
    );

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs).toContain("--file");
    expect(spawnArgs).toContain("/workspace/prompt.md");
  });
});
