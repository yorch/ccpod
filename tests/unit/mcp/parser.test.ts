import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractHttpMcpPorts, parseMcpJson } from "../../../src/mcp/parser.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccpod-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseMcpJson", () => {
  it("returns null when .mcp.json does not exist", () => {
    expect(parseMcpJson(makeTempDir())).toBeNull();
  });

  it("parses valid file with mcpServers", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { foo: { type: "http", url: "http://localhost:3000" } },
      }),
    );
    const result = parseMcpJson(dir);
    expect(result).not.toBeNull();
    expect(result?.mcpServers?.foo.type).toBe("http");
  });

  it("parses file with no mcpServers key", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".mcp.json"), "{}");
    const result = parseMcpJson(dir);
    expect(result).not.toBeNull();
    expect(result?.mcpServers).toBeUndefined();
  });
});

describe("extractHttpMcpPorts", () => {
  it("extracts port from http server", () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { type: "http", url: "http://localhost:8080" } },
      }),
    ).toEqual([8080]);
  });

  it("extracts port from sse server", () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { type: "sse", url: "http://localhost:9000/sse" } },
      }),
    ).toEqual([9000]);
  });

  it("skips stdio servers", () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { command: "node server.js", type: "stdio" } },
      }),
    ).toEqual([]);
  });

  it("skips servers with no url", () => {
    expect(
      extractHttpMcpPorts({ mcpServers: { a: { type: "http" } } }),
    ).toEqual([]);
  });

  it("deduplicates identical ports across servers", () => {
    const ports = extractHttpMcpPorts({
      mcpServers: {
        a: { type: "http", url: "http://localhost:3000" },
        b: { type: "sse", url: "http://localhost:3000/events" },
      },
    });
    expect(ports).toEqual([3000]);
  });

  it("ignores invalid URLs without throwing", () => {
    expect(
      extractHttpMcpPorts({
        mcpServers: { a: { type: "http", url: "not-a-url" } },
      }),
    ).toEqual([]);
  });

  it("returns empty array for empty mcpServers", () => {
    expect(extractHttpMcpPorts({ mcpServers: {} })).toEqual([]);
  });

  it("returns empty array when mcpServers absent", () => {
    expect(extractHttpMcpPorts({})).toEqual([]);
  });
});
