---
title: MCP Auto-detection
description: Expose Model Context Protocol server ports automatically.
---

Claude Code uses the [Model Context Protocol](https://modelcontextprotocol.io) to talk to external servers (HTTP/SSE or stdio). HTTP/SSE servers need their port reachable from inside the container. ccpod handles this for you.

## How it works

If the project root contains a `.mcp.json` and the profile has `ports.autoDetectMcp: true` (default), ccpod parses the file at startup, extracts every HTTP/SSE entry, and adds the corresponding port mappings to the container spec.

```json
// .mcp.json
{
  "mcpServers": {
    "filesystem": {
      "type": "http",
      "url": "http://localhost:8765"
    },
    "git": {
      "type": "sse",
      "url": "http://localhost:8766/sse"
    }
  }
}
```

Both `8765` and `8766` are exposed automatically. No `ports.list` entry needed.

## Disable it

```yaml
ports:
  autoDetectMcp: false
```

Or list ports manually:

```yaml
ports:
  list:
    - "8765:8765"
```

## stdio MCP servers

`stdio` MCP servers don't need port forwarding — they're spawned as child processes by Claude. They *do* need their runtime binary inside the container.

- `npx`-based MCPs (`@modelcontextprotocol/server-*`, etc.) **just work** because the base image bundles Node.js.
- Other runtimes (Python, Go, custom binaries) require a custom image. Set `image.use: build` in the profile and add the runtime to your `Dockerfile`.

## Inspecting the result

```sh
ccpod config show
```

The `ports:` section in the resolved config lists every mapping ccpod will hand to Docker — manual + auto-detected combined.
