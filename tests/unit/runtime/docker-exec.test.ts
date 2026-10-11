import { describe, expect, it, mock } from 'bun:test';
import { captureDockerProcess } from '../../../src/runtime/docker.ts';

function fakeProcess(exitsImmediately: boolean) {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
      controller.enqueue(new TextEncoder().encode('  output  '));
      if (exitsImmediately) {
        controller.close();
      }
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
      controller.enqueue(new TextEncoder().encode('  warning  '));
      if (exitsImmediately) {
        controller.close();
      }
    },
  });
  if (exitsImmediately) {
    resolveExited(0);
  }
  const kill = mock((signal?: NodeJS.Signals) => {
    stdoutController.close();
    stderrController.close();
    resolveExited(137);
    return signal;
  });
  return { exited, kill, pid: 1, stderr, stdout };
}

describe('dockerExec timeout process handling', () => {
  it('kills, drains output, and reaps a timed-out subprocess', async () => {
    const process = fakeProcess(false);
    await expect(
      captureDockerProcess(process, 10, (signal) => process.kill(signal)),
    ).rejects.toThrow(/timed out after 10ms/);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('preserves normal exit status and output without timeout', async () => {
    const process = fakeProcess(true);
    const result = await captureDockerProcess(process);
    expect(process.kill).not.toHaveBeenCalled();
    expect(result).toEqual({
      exitCode: 0,
      stderr: 'warning',
      stdout: 'output',
    });
  });
});
