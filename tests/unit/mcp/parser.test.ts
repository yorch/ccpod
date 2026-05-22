import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHttpMcpPorts, parseMcpJson } from '../../../src/mcp/parser.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccpod-mcp-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('parseMcpJson', () => {
  it('returns null when .mcp.json does not exist', () => {
    expect(parseMcpJson(makeTempDir())).toBeNull();
  });

  it('parses valid file with mcpServers', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { foo: { type: 'http', url: 'http://localhost:3000' } },
      }),
    );
    const result = parseMcpJson(dir);
    expect(result).not.toBeNull();
    expect(result?.mcpServers?.foo.type).toBe('http');
  });

  it('parses file with no mcpServers key', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.mcp.json'), '{}');
    const result = parseMcpJson(dir);
    expect(result).not.toBeNull();
    expect(result?.mcpServers).toBeUndefined();
  });

  it('returns null and warns on malformed JSON', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.mcp.json'), '{ not valid json');
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(parseMcpJson(dir)).toBeNull();
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => /failed to parse .mcp.json/.test(w))).toBe(
      true,
    );
  });

  it('returns null and warns on schema-invalid contents', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { foo: { type: 'invalid-type' } } }),
    );
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(parseMcpJson(dir)).toBeNull();
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => /schema validation/.test(w))).toBe(true);
  });

  it('rejects more than 64 server entries', () => {
    const dir = makeTempDir();
    const mcpServers: Record<string, { type: string }> = {};
    for (let i = 0; i < 65; i++) {
      mcpServers[`s${i}`] = { type: 'stdio' };
    }
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers }));
    const original = console.warn;
    console.warn = () => {};
    try {
      expect(parseMcpJson(dir)).toBeNull();
    } finally {
      console.warn = original;
    }
  });
});

describe('extractHttpMcpPorts', () => {
  it('extracts port from http server', () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { type: 'http', url: 'http://localhost:8080' } },
      }),
    ).toEqual([8080]);
  });

  it('extracts port from sse server', () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { type: 'sse', url: 'http://localhost:9000/sse' } },
      }),
    ).toEqual([9000]);
  });

  it('skips stdio servers', () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { command: 'node server.js', type: 'stdio' } },
      }),
    ).toEqual([]);
  });

  it('skips servers with no url', () => {
    expect(
      extractHttpMcpPorts({ mcpServers: { a: { type: 'http' } } }),
    ).toEqual([]);
  });

  it('deduplicates identical ports across servers', () => {
    const ports = extractHttpMcpPorts({
      mcpServers: {
        a: { type: 'http', url: 'http://localhost:3000' },
        b: { type: 'sse', url: 'http://localhost:3000/events' },
      },
    });
    expect(ports).toEqual([3000]);
  });

  it('ignores invalid URLs without throwing', () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { type: 'http', url: 'not-a-url' } },
      }),
    ).toEqual([]);
  });

  it('returns empty array for empty mcpServers', () => {
    expect(extractHttpMcpPorts({ mcpServers: {} })).toEqual([]);
  });

  it('returns empty array when mcpServers absent', () => {
    expect(extractHttpMcpPorts({})).toEqual([]);
  });

  it('rejects out-of-range ports and warns', () => {
    // Node's URL parser already rejects ports > 65535; this guards the lower
    // bound (port "0"), which URL.port surfaces as "0" rather than rejecting.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const ports = extractHttpMcpPorts({
        mcpServers: {
          bad: { type: 'http', url: 'http://localhost:0' },
          ok: { type: 'http', url: 'http://localhost:3000' },
        },
      });
      expect(ports).toEqual([3000]);
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => /out of valid range/.test(w))).toBe(true);
  });
});
