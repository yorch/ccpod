import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const servers: Server[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const tempDirs: string[] = [];

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function ready(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`proxy child exited before ready: ${stderr}`);
    }
    text += new TextDecoder().decode(chunk.value);
  }
  return Number(text.trim().split(' ').at(-1));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('AuthProxy process-shared refresh lock', () => {
  it('serializes fallback-account readers across temp dirs against a rotating endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccpod-auth-process-'));
    tempDirs.push(dir);
    const store = join(dir, 'credentials.json');
    const home = join(dir, 'home');
    mkdirSync(home, { mode: 0o700 });
    const temporaryDirs = [join(dir, 'tmp-one'), join(dir, 'tmp-two')];
    for (const temporaryDir of temporaryDirs) {
      mkdirSync(temporaryDir, { mode: 0o700 });
    }
    writeFileSync(
      store,
      JSON.stringify({
        accessToken: 'expired',
        expiresAt: 0,
        refreshToken: 'r1',
      }),
    );
    let refreshes = 0;
    let refreshTokenConsumed = false;
    const token = await listen(async (req, res) => {
      if (req.url === '/token') {
        refreshes++;
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
        }
        const body = JSON.parse(raw) as { refresh_token: string };
        if (body.refresh_token !== 'r1' || refreshTokenConsumed) {
          res.writeHead(400).end('{"error":"invalid_grant"}');
          return;
        }
        // Consume r1 before delaying; a concurrent reuse must fail.
        refreshTokenConsumed = true;
        await new Promise((resolve) => setTimeout(resolve, 150));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'fresh',
            expires_in: 86400,
            refresh_token: 'r2',
          }),
        );
        return;
      }
      req.resume();
      res.writeHead(200).end('ok');
    });
    const api = await listen((req, res) => {
      req.resume();
      res.writeHead(200).end('ok');
    });
    const moduleUrl = new URL('../../../src/auth/proxy.ts', import.meta.url)
      .href;
    const script = `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      process.umask(0o022);
      const { AuthProxy } = await import(${JSON.stringify(moduleUrl)});
      const file = process.env.CREDS;
      let passedBarrier = false;
      const proxy = new AuthProxy({ hostname:'127.0.0.1', apiUpstream:process.env.API,
        tokenEndpoint:process.env.TOKEN, sentinelKey:'synthetic-sentinel',
        readCredentials:()=>{
          if (!passedBarrier) {
            const marker = file+'.'+process.env.PROCESS_INDEX;
            const other = file+'.'+(process.env.PROCESS_INDEX === 'one' ? 'two' : 'one');
            writeFileSync(marker, 'ready');
            const deadline = Date.now()+5000;
            while (!existsSync(other) && Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
            if (!existsSync(other)) throw new Error('process barrier timeout');
            passedBarrier = true;
          }
          return JSON.parse(readFileSync(file,'utf8'));
        },
        writeCredentials:(c)=>writeFileSync(file,JSON.stringify(c),{mode:0o600}) });
      await proxy.start(); console.log('READY '+proxy.resolvedPort);
      process.on('SIGTERM', async()=>{ await proxy.stop(); process.exit(0); });
    `;
    const env = {
      ...process.env,
      API: api,
      CREDS: store,
      HOME: home,
      TOKEN: `${token}/token`,
    };
    for (const [index, processIndex] of ['one', 'two'].entries()) {
      const childEnv = {
        ...env,
        PROCESS_INDEX: processIndex,
        TEMP: temporaryDirs[index],
        TMP: temporaryDirs[index],
        TMPDIR: temporaryDirs[index],
        USER: `requested-account-${processIndex}`,
      };
      const child = Bun.spawn(['bun', '-e', script], {
        env: childEnv,
        stderr: 'pipe',
        stdout: 'pipe',
      });
      children.push(child);
    }
    const ports = await Promise.all(children.map(ready));
    for (const port of ports) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        headers: { 'x-api-key': 'synthetic-sentinel' },
      });
      expect(response.status).toBe(200);
    }
    expect(refreshes).toBe(1);
    expect(JSON.parse(readFileSync(store, 'utf8')).refreshToken).toBe('r2');
    const lockDir = join(home, '.ccpod', 'oauth-locks');
    const lockFiles = readdirSync(lockDir);
    expect(lockFiles).toHaveLength(1);
    const databaseName = lockFiles[0];
    if (!databaseName) {
      throw new Error('Expected the OAuth lock database to exist');
    }
    expect(databaseName).toMatch(/^[a-f\d]{64}\.sqlite$/);
    expect(statSync(join(lockDir, databaseName)).mode & 0o777).toBe(0o600);
  });
});
