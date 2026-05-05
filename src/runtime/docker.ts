import { detectRuntime } from './detector.ts';

function runtimeContext(): { binary: string; env: NodeJS.ProcessEnv } {
  const runtime = detectRuntime();
  return {
    binary: runtime.name === 'podman' ? 'podman' : 'docker',
    env: { ...process.env, DOCKER_HOST: `unix://${runtime.socketPath}` },
  };
}

/** Run a docker command, capture stdout/stderr. Never throws on non-zero exit. */
export async function dockerExec(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { binary, env } = runtimeContext();
  const proc = Bun.spawn([binary, ...args], {
    env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

/** Run a docker command with inherited stdio. Returns container exit code. */
export async function dockerSpawn(args: string[]): Promise<number> {
  const { binary, env } = runtimeContext();
  const proc = Bun.spawn([binary, ...args], {
    env,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  });
  return proc.exited;
}
