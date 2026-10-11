import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dockerExec, dockerSpawn } from '../../../src/runtime/docker.ts';

let root = '';
let originalEnv: Record<string, string | undefined> = {};
const changedEnvKeys = [
  'PATH',
  'DOCKER_HOST',
  'BUN_OPTIONS',
  'CAPTURE_ARGS',
  'CAPTURE_ENV',
  'CAPTURE_FILE',
  'UNSET_FORWARD',
  'CONFLICT_FORWARD',
  'TOKEN',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
];

afterEach(async () => {
  if (root) {
    await rm(root, { force: true, recursive: true });
  }
  root = '';
  for (const key of changedEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv = {};
});

async function setupFakeDocker(exitCode = 0) {
  root = await mkdtemp(join(tmpdir(), 'ccpod-docker-env-test-'));
  originalEnv = Object.fromEntries(
    changedEnvKeys.map((key) => [key, process.env[key]]),
  );
  const bin = join(root, 'bin');
  await mkdir(bin);
  await Bun.write(join(root, 'capture-path'), '');
  await Bun.write(join(root, 'capture-env'), '');
  const executable = join(bin, 'docker');
  await Bun.write(
    executable,
    `#!${process.execPath}\nimport { writeFile, stat } from 'node:fs/promises';
const args = process.argv.slice(2);
const out = process.env.CAPTURE_ARGS;
await writeFile(out, JSON.stringify({ args, env: process.env }));
const envFiles = [];
const resolvedEnv = {};
for (let i = 0; i < args.length; i++) {
 let filePath;
 if (args[i] === '--env-file') filePath = args[++i];
 else if (args[i]?.startsWith('--env-file=')) filePath = args[i].slice('--env-file='.length);
 if (filePath) {
  const content = await Bun.file(filePath).text();
  envFiles.push({ filePath, content });
  for (const line of content.split('\\n')) {
   const equals = line.indexOf('=');
   if (equals > 0) resolvedEnv[line.slice(0, equals)] = line.slice(equals + 1);
  }
 }
}
const privateFile = envFiles.find(({ filePath }) => filePath.includes('/ccpod-env-'));
if (privateFile) {
 const info = await stat(privateFile.filePath);
 await writeFile(process.env.CAPTURE_FILE, JSON.stringify({ ...privateFile, envFiles, resolvedEnv, fileMode: info.mode & 0o777, dirMode: (await stat(new URL('.', 'file://' + privateFile.filePath))).mode & 0o777 }));
}
process.exit(${exitCode});\n`,
  );
  await chmod(executable, 0o700);
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.DOCKER_HOST = 'tcp://synthetic.example:2375';
  process.env.CAPTURE_ARGS = join(root, 'args.json');
  process.env.CAPTURE_ENV = join(root, 'env.json');
  process.env.CAPTURE_FILE = join(root, 'file.json');
  return root;
}

async function listTransportDirectories() {
  const prefix = `ccpod-env-${process.getuid?.() ?? 'user'}-`;
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith(prefix))
    .sort();
}

describe('docker environment-file transport', () => {
  test('dockerExec transports main-container secrets privately without host env/argv leakage', async () => {
    const dir = await setupFakeDocker();
    const value = 'safe-secret-without-linebreak';
    process.env.PATH = `${dir}/attacker:${process.env.PATH}`;
    delete process.env.UNSET_FORWARD;
    process.env.CONFLICT_FORWARD = 'host-value';
    delete process.env.BUN_OPTIONS;
    const extraEnv = {
      BUN_OPTIONS: '--require poison',
      CONFLICT_FORWARD: 'forwarded-value',
      DYLD_INSERT_LIBRARIES: '/synthetic/dyld-poison.dylib',
      LD_PRELOAD: '/synthetic/loader-poison.so',
      PATH: 'loader-poison',
      UNSET_FORWARD: value,
    };
    const result = await dockerExec(
      [
        'run',
        '-e',
        'UNSET_FORWARD',
        '-e',
        'CONFLICT_FORWARD',
        '-e',
        'CCPOD_CONTROL=kept',
        'image',
        'grep',
        '-e',
        'UNSET_FORWARD',
        '/workspace/file',
        'bun',
        'run',
        'tool',
        '-e',
        'UNSET_FORWARD',
      ],
      extraEnv,
    );
    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(
      await readFile(join(dir, 'args.json'), 'utf8'),
    ) as { args: string[]; env: Record<string, string> };
    expect(captured.args).not.toContain(value);
    expect(captured.args).not.toContain('forwarded-value');
    expect(captured.args).toContain('CCPOD_CONTROL=kept');
    const dockerOptions = captured.args.slice(
      0,
      captured.args.indexOf('image'),
    );
    expect(dockerOptions).not.toContain('UNSET_FORWARD');
    expect(dockerOptions).not.toContain('CONFLICT_FORWARD');
    expect(captured.args.slice(captured.args.indexOf('image') + 1)).toEqual([
      'grep',
      '-e',
      'UNSET_FORWARD',
      '/workspace/file',
      'bun',
      'run',
      'tool',
      '-e',
      'UNSET_FORWARD',
    ]);
    expect(captured.args).not.toContain('/synthetic/loader-poison.so');
    expect(captured.args).not.toContain('/synthetic/dyld-poison.dylib');
    expect(captured.env.LD_PRELOAD).toBeUndefined();
    expect(captured.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(captured.env.UNSET_FORWARD).toBeUndefined();
    expect(captured.env.CONFLICT_FORWARD).toBe('host-value');
    expect(captured.env.PATH).toContain(`${dir}/bin`);
    expect(captured.env.BUN_OPTIONS).toBeUndefined();
    expect(captured.env.DOCKER_HOST).toBe('tcp://synthetic.example:2375');
    const file = JSON.parse(await readFile(join(dir, 'file.json'), 'utf8')) as {
      filePath: string;
      content: string;
      fileMode: number;
      dirMode: number;
    };
    expect(file.content).toContain(`UNSET_FORWARD=${value}`);
    expect(file.content).toContain('PATH=loader-poison');
    expect(file.content).toContain('BUN_OPTIONS=--require poison');
    expect(file.content).toContain('LD_PRELOAD=/synthetic/loader-poison.so');
    expect(file.content).toContain(
      'DYLD_INSERT_LIBRARIES=/synthetic/dyld-poison.dylib',
    );
    expect(file.fileMode).toBe(0o600);
    expect(file.dirMode).toBe(0o700);
    await expect(stat(file.filePath)).rejects.toThrow();
  });

  test('run removes every bare-env spelling and the private env-file wins', async () => {
    const dir = await setupFakeDocker();
    process.env.TOKEN = 'host-value';
    const existingEnvFile = join(dir, 'existing.env');
    const assignedEnvFile = join(dir, 'assigned.env');
    await Bun.write(existingEnvFile, 'TOKEN=old-file-value\\n');
    await Bun.write(assignedEnvFile, 'TOKEN=older-file-value\\n');
    const result = await dockerExec(
      [
        'run',
        '-i=false',
        '-d=true',
        '-it=false',
        '--env-file',
        existingEnvFile,
        `--env-file=${assignedEnvFile}`,
        '-a',
        'stdout',
        '-h',
        'host-name',
        '--net',
        'bridge',
        '-itw',
        '/workspace',
        '--cpu-count',
        '2',
        '--cpu-percent',
        '50',
        '--env=TOKEN',
        '-e=TOKEN',
        '-eTOKEN',
        '-e',
        'CCPOD_CONTROL=kept',
        '--env=CCPOD_INLINE=literal',
        'image',
        'grep',
        '-e',
        'TOKEN',
      ],
      { TOKEN: 'container-value' },
    );
    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(
      await readFile(join(dir, 'args.json'), 'utf8'),
    ) as {
      args: string[];
      env: Record<string, string>;
    };
    const imageIndex = captured.args.indexOf('image');
    const dockerOptions = captured.args.slice(0, imageIndex);
    expect(dockerOptions).toContain('-i=false');
    expect(dockerOptions).toContain('-d=true');
    expect(dockerOptions).toContain('-it=false');
    expect(dockerOptions).toContain(existingEnvFile);
    expect(dockerOptions).toContain(`--env-file=${assignedEnvFile}`);
    expect(dockerOptions).toContain('stdout');
    expect(dockerOptions).toContain('host-name');
    expect(dockerOptions).toContain('bridge');
    expect(dockerOptions).toContain('/workspace');
    expect(dockerOptions).toContain('2');
    expect(dockerOptions).toContain('50');
    expect(dockerOptions).not.toContain('--env=TOKEN');
    expect(dockerOptions).not.toContain('-e=TOKEN');
    expect(dockerOptions).not.toContain('-eTOKEN');
    expect(dockerOptions).not.toContain('TOKEN');
    expect(dockerOptions).toContain('CCPOD_CONTROL=kept');
    expect(dockerOptions).toContain('--env=CCPOD_INLINE=literal');
    expect(captured.args.slice(imageIndex)).toEqual([
      'image',
      'grep',
      '-e',
      'TOKEN',
    ]);
    expect(captured.args).not.toContain('container-value');
    expect(captured.env.TOKEN).toBe('host-value');
    const file = JSON.parse(await readFile(join(dir, 'file.json'), 'utf8')) as {
      filePath: string;
      content: string;
      envFiles: Array<{ filePath: string }>;
      resolvedEnv: Record<string, string>;
    };
    expect(file.content).toContain('TOKEN=container-value');
    expect(file.envFiles.map(({ filePath }) => filePath)).toEqual([
      existingEnvFile,
      assignedEnvFile,
      file.filePath,
    ]);
    expect(file.resolvedEnv.TOKEN).toBe('container-value');
  });

  test('create handles attached env spellings and keeps bun run application args', async () => {
    const dir = await setupFakeDocker();
    delete process.env.TOKEN;
    const result = await dockerExec(
      [
        'create',
        '-i=false',
        '-it=false',
        '--cpu-count',
        '2',
        '--cpu-percent',
        '50',
        '--net',
        'bridge',
        '-itw',
        '/workspace',
        '--env=TOKEN',
        '-e=TOKEN',
        '-eTOKEN',
        '-e',
        'CCPOD_CONTROL=kept',
        '--',
        'image',
        'bun',
        'run',
        'script',
        '-e',
        'TOKEN',
      ],
      { TOKEN: 'synthetic-create-secret' },
    );
    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(
      await readFile(join(dir, 'args.json'), 'utf8'),
    ) as {
      args: string[];
      env: Record<string, string>;
    };
    const imageIndex = captured.args.indexOf('image');
    const dockerOptions = captured.args.slice(0, imageIndex);
    expect(dockerOptions).toContain('--env-file');
    expect(dockerOptions).toContain('-i=false');
    expect(dockerOptions).toContain('-it=false');
    expect(dockerOptions).toContain('--cpu-count');
    expect(dockerOptions).toContain('--cpu-percent');
    expect(dockerOptions).toContain('--net');
    expect(dockerOptions).toContain('bridge');
    expect(dockerOptions).toContain('-itw');
    expect(dockerOptions).toContain('/workspace');
    expect(dockerOptions).not.toContain('TOKEN');
    expect(dockerOptions).toContain('CCPOD_CONTROL=kept');
    expect(captured.args.slice(imageIndex)).toEqual([
      'image',
      'bun',
      'run',
      'script',
      '-e',
      'TOKEN',
    ]);
    expect(captured.args).not.toContain('synthetic-create-secret');
    expect(captured.env.TOKEN).toBeUndefined();
    const file = JSON.parse(await readFile(join(dir, 'file.json'), 'utf8')) as {
      filePath: string;
      content: string;
      resolvedEnv: Record<string, string>;
    };
    expect(file.content).toContain('TOKEN=synthetic-create-secret');
    expect(file.resolvedEnv.TOKEN).toBe('synthetic-create-secret');
    await expect(stat(file.filePath)).rejects.toThrow();
  });

  test('literal env assignments for a forwarded key remain explicit', async () => {
    const dir = await setupFakeDocker();
    process.env.TOKEN = 'host-value';
    const result = await dockerExec(
      [
        'run',
        '--env=TOKEN=literal',
        '-eTOKEN=attached-literal',
        'image',
        'grep',
        '-e',
        'TOKEN',
      ],
      { TOKEN: 'forwarded-value' },
    );
    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(
      await readFile(join(dir, 'args.json'), 'utf8'),
    ) as { args: string[] };
    const imageIndex = captured.args.indexOf('image');
    expect(captured.args.slice(0, imageIndex)).toContain('--env=TOKEN=literal');
    expect(captured.args.slice(0, imageIndex)).toContain(
      '-eTOKEN=attached-literal',
    );
    expect(captured.args.slice(imageIndex)).toEqual([
      'image',
      'grep',
      '-e',
      'TOKEN',
    ]);
    expect(captured.args).not.toContain('forwarded-value');
    const file = JSON.parse(await readFile(join(dir, 'file.json'), 'utf8')) as {
      content: string;
    };
    expect(file.content).toContain('TOKEN=forwarded-value');
  });

  test('dockerSpawn transports sidecar-style env and cleans up after nonzero exit', async () => {
    const dir = await setupFakeDocker(17);
    const code = await dockerSpawn(
      ['run', '--name', 'sidecar-test', '-e', 'SIDE_TOKEN', 'image'],
      {
        SIDE_TOKEN: 'synthetic-sidecar-secret',
      },
    );
    expect(code).toBe(17);
    const args = JSON.parse(await readFile(join(dir, 'args.json'), 'utf8')) as {
      args: string[];
      env: Record<string, string>;
    };
    expect(args.args).not.toContain('synthetic-sidecar-secret');
    expect(args.args).not.toContain('SIDE_TOKEN');
    expect(args.env.SIDE_TOKEN).toBeUndefined();
    const file = JSON.parse(await readFile(join(dir, 'file.json'), 'utf8')) as {
      filePath: string;
    };
    await expect(stat(file.filePath)).rejects.toThrow();
  });

  test('cleans up after a real wrapper spawn failure', async () => {
    const dir = await setupFakeDocker();
    const before = await listTransportDirectories();
    const originalWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = (name: string) => {
      if (name === 'docker') {
        return join(dir, 'missing-docker');
      }
      return originalWhich(name);
    };
    try {
      await expect(
        dockerSpawn(['run', 'image'], { TOKEN: 'synthetic' }),
      ).rejects.toThrow();
    } finally {
      (Bun as unknown as { which: typeof Bun.which }).which = originalWhich;
    }
    expect(await listTransportDirectories()).toEqual(before);
    await expect(readFile(join(dir, 'args.json'))).rejects.toThrow();
  });

  test('cleans up after captured-stream read failure in dockerExec', async () => {
    await setupFakeDocker();
    const runtime = Bun as unknown as { spawn: typeof Bun.spawn };
    const originalSpawn = Bun.spawn;
    let capturedPath = '';
    runtime.spawn = ((command: string[]) => {
      const envFileIndex = command.indexOf('--env-file');
      capturedPath = command[envFileIndex + 1] ?? '';
      const brokenStream = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('synthetic stream read failure'));
          },
        });
      return {
        exited: Promise.resolve(0),
        kill: () => {},
        pid: 1,
        stderr: brokenStream(),
        stdout: brokenStream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    try {
      await expect(
        dockerExec(['run', 'image'], { TOKEN: 'synthetic' }),
      ).rejects.toThrow('synthetic stream read failure');
    } finally {
      runtime.spawn = originalSpawn;
    }
    expect(capturedPath).not.toBe('');
    await expect(stat(capturedPath)).rejects.toThrow();
    await expect(stat(dirname(capturedPath))).rejects.toThrow();
  });

  test('rejects invalid identifiers and unknown option boundaries before spawning', async () => {
    const dir = await setupFakeDocker();
    const directoriesBeforeUnknownOption = await listTransportDirectories();
    await expect(
      dockerExec(['run', 'image'], { 'BAD=NAME': 'value' }),
    ).rejects.toThrow('Invalid environment variable name');
    await expect(
      dockerSpawn(['run', 'image'], { TOKEN: 'first\nINJECTED=yes' }),
    ).rejects.toThrow('forbidden');
    await expect(
      dockerExec(['run', 'image'], { TOKEN: 'first\rINJECTED=yes' }),
    ).rejects.toThrow('forbidden');
    await expect(
      dockerSpawn(['run', 'image'], { TOKEN: 'contains\0nul' }),
    ).rejects.toThrow('forbidden');
    await expect(
      dockerExec(['run', '--unknown-option', 'value', '-e', 'TOKEN', 'image'], {
        TOKEN: 'forwarded',
      }),
    ).rejects.toThrow('Cannot safely parse Docker run/create option');
    expect(await listTransportDirectories()).toEqual(
      directoriesBeforeUnknownOption,
    );
    await expect(readFile(join(dir, 'args.json'))).rejects.toThrow();
  });
});
