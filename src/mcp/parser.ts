import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const MAX_SERVERS = 64;

const mcpServerSchema = z
  .object({
    command: z.string().optional(),
    type: z.enum(['stdio', 'http', 'sse']).optional(),
    url: z.string().optional(),
  })
  .passthrough();

const mcpConfigSchema = z
  .object({
    mcpServers: z
      .record(z.string(), mcpServerSchema)
      .refine((s) => Object.keys(s).length <= MAX_SERVERS, {
        message: `mcpServers may not exceed ${MAX_SERVERS} entries`,
      })
      .optional(),
  })
  .passthrough();

export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export function parseMcpJson(projectDir: string): McpConfig | null {
  const mcpPath = join(projectDir, '.mcp.json');
  if (!existsSync(mcpPath)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mcpPath, 'utf8'));
  } catch (err) {
    console.warn(
      `Warning: failed to parse .mcp.json: ${(err as Error).message}`,
    );
    return null;
  }
  const result = mcpConfigSchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      `Warning: .mcp.json failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
    return null;
  }
  return result.data;
}

export function extractHttpMcpPorts(config: McpConfig): number[] {
  const ports: number[] = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if ((server.type === 'http' || server.type === 'sse') && server.url) {
      let parsed: URL;
      try {
        parsed = new URL(server.url);
      } catch {
        continue;
      }
      if (!parsed.port) {
        continue;
      }
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.warn(
          `Warning: MCP server '${name}' port ${parsed.port} out of valid range (1-65535); skipping.`,
        );
        continue;
      }
      ports.push(port);
    }
  }
  return [...new Set(ports)];
}
