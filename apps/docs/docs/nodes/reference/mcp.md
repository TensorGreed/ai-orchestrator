<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# MCP nodes

Model Context Protocol clients and the workflow-as-MCP-tool exposure node.

1 node.

---
### `mcp_tool` — MCP Tool

Directly invokes an MCP tool outside the agent loop.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `serverId` | `string` | yes | — |
| `toolName` | `string` | yes | — |
| `argsTemplate` | `string` | no | — |
| `connection` | `object` | no | — |

**Example config**

```json
{
  "serverId": "mock-mcp",
  "toolName": "get_current_time",
  "argsTemplate": "{\"tz\":\"UTC\"}",
  "connection": {
    "endpoint": "http://127.0.0.1:7001/mcp",
    "transport": "http_streamable",
    "timeoutMs": 120000,
    "authType": "none"
  }
}
```
