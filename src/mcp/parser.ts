import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface McpServer {
  command?: string;
  type?: "stdio" | "http" | "sse";
  url?: string;
}

interface McpConfig {
  mcpServers?: Record<string, McpServer>;
}

export function parseMcpJson(projectDir: string): McpConfig | null {
  const mcpPath = join(projectDir, ".mcp.json");
  if (!existsSync(mcpPath)) return null;
  return JSON.parse(readFileSync(mcpPath, "utf8")) as McpConfig;
}

export function extractHttpMcpPorts(config: McpConfig): number[] {
  const ports: number[] = [];
  for (const server of Object.values(config.mcpServers ?? {})) {
    if ((server.type === "http" || server.type === "sse") && server.url) {
      try {
        const port = new URL(server.url).port;
        if (port) ports.push(Number(port));
      } catch {
        // ignore invalid URLs
      }
    }
  }
  return [...new Set(ports)];
}
