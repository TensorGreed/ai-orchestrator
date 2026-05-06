# Expose a Workflow as an MCP Tool

The `mcp_server_trigger` node turns any L2M workflow into a Model Context Protocol tool that other agents can invoke. The agent doesn't know — and doesn't need to know — that the "tool" it's calling is actually a multi-node workflow with its own LLMs, retrieval, branching, and side effects.

This is the **agent → workflow → agent** composition pattern, and it's why L2M positions itself as MCP-native rather than as just an MCP client.

## Why this matters

Most workflow tools let agents **call** tools. L2M lets workflows **be** tools. That asymmetry unlocks:

- **Encapsulating a complex pipeline** behind a single MCP tool definition. Other teams' agents call your `query_knowledge_base` workflow without knowing it routes through five connectors and a guardrail.
- **Recursive Swarm composition** across instances. An L2M Supervisor calling tools from a remote L2M instance is, structurally, an MCP client → MCP server hop. The remote workflow can itself attach `mcp_server_trigger` to its own composed tools.
- **Stable APIs over evolving implementations.** The MCP tool's input schema is the contract. The workflow behind it can be rewritten, optimized, and extended without breaking callers.

n8n's MCP support is one-way (its agent can call MCP tools). Langflow and Flowise have neither direction. The two-way story is L2M's.

## How it works

When you add an `mcp_server_trigger` node to a workflow and save it, L2M registers two routes:

- `GET /api/mcp-server/:path/manifest` — returns the MCP-compatible tool definition (name, description, inputSchema)
- `POST /api/mcp-server/:path/invoke` — accepts a JSON body with `arguments`, runs the workflow with those arguments injected as input, returns the workflow output

Downstream nodes in the workflow read the tool arguments via the standard <span v-pre>`{{ ... }}`</span> template syntax — for example, <span v-pre>`{{question}}`</span> if the tool's `inputSchema` declares a `question` property.

## Configuration

| Field | Required | Description |
|---|---|---|
| `path` | yes | URL slug for this tool. Must be unique per instance. The endpoint becomes `/api/mcp-server/<path>/...` |
| `toolName` | yes | The tool's name as advertised to MCP clients. Use snake_case. |
| `toolDescription` | recommended | Human-readable description shown to LLMs deciding whether to call this tool. Keep it concise but specific. |
| `inputSchema` | recommended | JSON Schema describing the tool's arguments. Without one, callers can pass anything; with one, the manifest tells LLMs exactly what to send. |
| `authMode` | yes | `public` (anyone with the URL can invoke) or `bearer` (requires `Authorization: Bearer <secret>` header) |
| `secretRef.secretId` | when `authMode: bearer` | Reference to a stored secret containing the bearer token |

## Recipe — knowledge-base tool

A workflow that exposes "answer a question against our docs" as an MCP tool:

```text
mcp_server_trigger ──▶ rag_retrieve ──▶ llm_call ──▶ output
       │                                                
       │  inputSchema.properties.question = string      
       │  toolName = "query_knowledge_base"             
       └  authMode = "bearer"                           
```

Configuration values (see the node config modal):

```json
{
  "path": "kb",
  "toolName": "query_knowledge_base",
  "toolDescription": "Answer a question by retrieving relevant passages from the engineering knowledge base.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" }
    },
    "required": ["question"]
  },
  "authMode": "bearer",
  "secretRef": { "secretId": "sec_kb_token" }
}
```

The downstream `llm_call` reads <span v-pre>`{{question}}`</span> from the trigger payload, the `rag_retrieve` does the same.

## Try it

Once the workflow is saved, fetch the manifest:

```bash
curl http://localhost:4000/api/mcp-server/kb/manifest
```

Returns:

```json
{
  "name": "query_knowledge_base",
  "description": "Answer a question by retrieving relevant passages from the engineering knowledge base.",
  "inputSchema": {
    "type": "object",
    "properties": { "question": { "type": "string" } },
    "required": ["question"]
  }
}
```

Invoke it:

```bash
curl -X POST http://localhost:4000/api/mcp-server/kb/invoke \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"question": "How do I rotate the master encryption key?"}}'
```

## Wiring it into another agent

To call this tool from another L2M Agent Orchestrator node, add an `MCP Tool` node, set its server adapter to `http_mcp`, and point the endpoint at `http://localhost:4000/api/mcp-server/kb/invoke` (or wherever the instance is hosted). The agent will discover `query_knowledge_base` and treat it like any other MCP tool.

For external clients (Claude Desktop, custom agent runtimes, other MCP-aware tools), give them the same endpoint URL and the bearer token if `authMode: bearer`.

## Related

- [Agent loop](./agent-loop) — how the runtime calls MCP tools
- [MCP integration](../extensions/mcp) — using MCP tools inside L2M workflows (the inverse direction)
- [Webhook security](../security/secure-webhooks) — `mcp_server_trigger` shares the same secret + replay protection foundation
