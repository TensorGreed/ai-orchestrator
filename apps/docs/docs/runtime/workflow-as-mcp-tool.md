# Expose a Workflow as an MCP Tool

The `mcp_server_trigger` node ("Expose as MCP Tool") turns any L2M workflow into a Model Context Protocol tool that other agents can call. The agent doesn't know, and doesn't need to know, that the tool it's calling is a multi-node workflow with its own LLMs, retrieval, branching and side effects.

This is the **agent → workflow → agent** composition pattern, and it's why L2M is MCP-native rather than only an MCP client.

## Why this matters

L2M agents call MCP tools, and L2M workflows can **be** MCP tools. That unlocks:

- **Encapsulating a complex pipeline** behind a single tool definition. Other teams' agents call your `query_knowledge_base` workflow without knowing it routes through five connectors and a guardrail.
- **Composition across instances.** An L2M Supervisor calling tools of a remote L2M instance is an MCP client → MCP server hop. The remote workflow can itself use tools of other instances.
- **Stable APIs over evolving implementations.** The tool's input schema is the contract. The workflow behind it can be rewritten, optimized and extended without breaking callers.

## How it works

Workflows with an `mcp_server_trigger` are served through the [MCP gateway](../product/mcp-gateway):

1. Add an **Expose as MCP Tool** trigger to the workflow and set its `toolName`, `toolDescription` and `inputSchema`. Save.
2. On the **MCP servers** page, open **Toolsets**, create a toolset (or edit one) and add the workflow. The toolset's endpoint is `/mcp/<toolset-slug>`.
3. Open **Clients**, create a client scoped to the toolset, and copy its token and the config snippet into your MCP client.

The client connects to `POST /mcp/<toolset-slug>` over the MCP Streamable HTTP transport, lists the tools and calls them. Each call runs the workflow with the tool arguments as its input, records the run in execution history (trigger type `mcp_gateway`), reports a progress step per completed node, and returns the workflow output as the tool result. A canceled call cancels the run. The same toolset can also re-expose tools of registered MCP servers next to your workflows.

Downstream nodes read the tool arguments with the standard <span v-pre>`{{ ... }}`</span> template syntax, for example <span v-pre>`{{question}}`</span> when the tool's `inputSchema` declares a `question` property. The full arguments object is also available as <span v-pre>`{{arguments}}`</span>.

## Configuration

| Field | Required | Description |
|---|---|---|
| `toolName` | yes | The tool's name as advertised to MCP clients. Use snake_case. |
| `toolDescription` | recommended | Description shown to LLMs deciding whether to call this tool. Keep it concise but specific. |
| `inputSchema` | recommended | JSON Schema describing the tool's arguments. Without one, callers can pass any object; with one, `tools/list` tells LLMs exactly what to send. |
| `path` | legacy routes only | URL slug for the legacy REST routes, `/api/mcp-server/<path>/...`. Must be unique per instance. |
| `authMode` | legacy routes only | `public` or `bearer` for the legacy REST routes. The gateway always requires a client token. |
| `secretRef.secretId` | when `authMode: bearer` | Stored secret holding the bearer token of the legacy routes. |

## Recipe: knowledge-base tool

A workflow that exposes "answer a question against our docs" as an MCP tool:

```text
mcp_server_trigger ──▶ rag_retrieve ──▶ llm_call ──▶ output
       │
       │  inputSchema.properties.question = string
       └  toolName = "query_knowledge_base"
```

Trigger configuration:

```json
{
  "toolName": "query_knowledge_base",
  "toolDescription": "Answer a question by retrieving relevant passages from the engineering knowledge base.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" }
    },
    "required": ["question"]
  }
}
```

The downstream `rag_retrieve` and `llm_call` read <span v-pre>`{{question}}`</span> from the trigger payload.

## Try it

Add the workflow to a toolset with the slug `kb` and create a client for it. Then, with the token in `TOKEN`:

```bash
# 1. Open a session. The response carries an Mcp-Session-Id header.
curl -i http://localhost:4000/mcp/kb \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# 2. Call the tool in that session.
curl http://localhost:4000/mcp/kb \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <id from step 1>" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_knowledge_base","arguments":{"question":"How do I rotate the master encryption key?"}}}'

# 3. End the session.
curl -X DELETE http://localhost:4000/mcp/kb \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: <id from step 1>"
```

In practice an MCP client library or the client app does this for you; paste the snippet from the Clients view into its configuration.

## Wiring it into another L2M instance

To call the tool from an Agent Orchestrator on another L2M instance, register the endpoint in that instance's MCP server registry with the `http_mcp` adapter: endpoint `https://<l2m-host>/mcp/kb`, auth type Bearer, and a stored secret holding the client token. Attach an MCP Tool node that uses the registered server. The agent discovers `query_knowledge_base` and treats it like any other MCP tool.

## Legacy REST routes

The routes from earlier releases still work unchanged, configured by the trigger's `path`, `authMode` and `secretRef`:

- `GET /api/mcp-server/:path/manifest` returns the tool definition (name, description, inputSchema).
- `POST /api/mcp-server/:path/invoke` accepts `{"arguments": {...}}`, runs the workflow and returns its output.

```bash
curl -X POST http://localhost:4000/api/mcp-server/kb/invoke \
  -H "Authorization: Bearer <trigger secret>" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"question": "How do I rotate the master encryption key?"}}'
```

They are not the MCP protocol, so MCP clients cannot connect to them directly. Use them for plain HTTP callers; use a toolset endpoint for MCP clients.

## Related

- [MCP gateway](../product/mcp-gateway): toolsets, clients, policy and security
- [Agent loop](./agent-loop): how the runtime calls MCP tools
- [MCP integration](../extensions/mcp): using MCP tools inside L2M workflows (the inverse direction)
- [Webhook security](../security/secure-webhooks): the legacy routes share the webhook secret and replay protection
