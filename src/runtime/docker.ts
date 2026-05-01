import { detectRuntime } from "./detector.ts";

function dockerEnv(): NodeJS.ProcessEnv {
  const runtime = detectRuntime();
  return { ...process.env, DOCKER_HOST: `unix://${runtime.socketPath}` };
}

/** Run a docker command, capture stdout/stderr. Never throws on non-zero exit. */
export async function dockerExec(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["docker", ...args], {
    env: dockerEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/** Run a docker command with inherited stdio. Returns container exit code. */
export async function dockerSpawn(args: string[]): Promise<number> {
  const proc = Bun.spawn(["docker", ...args], {
    env: dockerEnv(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}
