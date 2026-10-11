import { detectRuntime } from './detector.ts';
import { prepareDockerArgs, withPrivateEnvFile } from './env-file.ts';

export interface DockerExecOptions {
  timeoutMs?: number;
}

interface CapturedProcess {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
  pid: number;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}

interface CapturedText {
  cancel: () => Promise<void>;
  text: Promise<string>;
}

function captureText(stream: ReadableStream<Uint8Array>): CapturedText {
  const reader = stream.getReader();
  const text = (async () => {
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return `${output}${decoder.decode()}`;
      }
      output += decoder.decode(value, { stream: true });
    }
  })().finally(() => reader.releaseLock());
  return {
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // A completed or errored stream needs no further cleanup.
      }
    },
    text,
  };
}

async function killAndDrain(
  proc: CapturedProcess,
  streams: CapturedText[],
  killGroup: (signal: NodeJS.Signals) => void,
) {
  try {
    killGroup('SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      // The process may have exited concurrently with the timeout.
    }
  }
  await proc.exited.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.all(streams.map((stream) => stream.text.catch(() => {}))).then(
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 250);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  if (!drained) {
    await Promise.all(streams.map((stream) => stream.cancel()));
  }
}

/** Run a captured Docker child, killing/reaping its process group on timeout. */
export async function captureDockerProcess(
  proc: CapturedProcess,
  timeoutMs?: number,
  killGroup: (signal: NodeJS.Signals) => void = (signal) => {
    if (process.platform === 'win32') {
      proc.kill(signal);
    } else {
      process.kill(-proc.pid, signal);
    }
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutCapture = captureText(proc.stdout);
  const stderrCapture = captureText(proc.stderr);
  const result = Promise.all([
    stdoutCapture.text,
    stderrCapture.text,
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({
    exitCode,
    stderr: stderr.trim(),
    stdout: stdout.trim(),
  }));
  if (timeoutMs === undefined) {
    return result;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await killAndDrain(proc, [stdoutCapture, stderrCapture], killGroup);
    throw new RangeError('timeoutMs must be a positive finite number');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const completed = await Promise.race([result, timedOut]);
  if (timer) {
    clearTimeout(timer);
  }
  if (completed) {
    return completed;
  }

  await killAndDrain(proc, [stdoutCapture, stderrCapture], killGroup);
  throw new Error(`docker command timed out after ${timeoutMs}ms`);
}

function runtimeContext(): { binary: string; env: NodeJS.ProcessEnv } {
  const runtime = detectRuntime();
  const name = runtime.name === 'podman' ? 'podman' : 'docker';
  return {
    // Resolve against ccpod's own PATH before constructing the child env. The
    // forwarded container environment is carried by a private env-file and
    // must never influence which Docker/Podman executable is launched.
    binary: Bun.which(name, { PATH: process.env.PATH }) ?? name,
    env: {
      ...process.env,
      DOCKER_HOST: runtime.dockerHost ?? `unix://${runtime.socketPath}`,
    },
  };
}

/** Run a docker command, capture stdout/stderr. Never throws on non-zero exit.
 *
 * `extraEnv` is supplied to `docker run` / `docker create` through a private,
 * short-lived env-file. Values are not placed in the Docker CLI environment or argv.
 */
export async function dockerExec(
  args: string[],
  extraEnv?: Record<string, string>,
  options: DockerExecOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  const { binary, env } = runtimeContext();
  const execute = async (dockerArgs: string[]) => {
    const proc = Bun.spawn([binary, ...dockerArgs], {
      detached: true,
      env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    return captureDockerProcess(proc, options.timeoutMs, (signal) => {
      if (process.platform === 'win32') {
        proc.kill(signal);
      } else {
        process.kill(-proc.pid, signal);
      }
    });
  };
  if (!extraEnv || Object.keys(extraEnv).length === 0) {
    return execute(args);
  }

  return withPrivateEnvFile(extraEnv, async (filePath) =>
    execute(prepareDockerArgs(args, new Set(Object.keys(extraEnv)), filePath)),
  );
}

/**
 * Run a docker command with inherited stdio. Returns container exit code.
 *
 * `extraEnv` is supplied to `docker run` / `docker create` through a private,
 * short-lived env-file. Values are not placed in the Docker CLI environment or argv.
 */
export async function dockerSpawn(
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<number> {
  const { binary, env } = runtimeContext();
  const execute = (dockerArgs: string[]) => {
    const proc = Bun.spawn([binary, ...dockerArgs], {
      env,
      stderr: 'inherit',
      stdin: 'inherit',
      stdout: 'inherit',
    });
    return proc.exited;
  };
  if (!extraEnv || Object.keys(extraEnv).length === 0) {
    return execute(args);
  }

  return withPrivateEnvFile(extraEnv, async (filePath) =>
    execute(prepareDockerArgs(args, new Set(Object.keys(extraEnv)), filePath)),
  );
}
