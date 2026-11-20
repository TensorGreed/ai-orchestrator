---
title: "MCP integration: connect MCP tools to agents"
description: "How MCP tools reach L2M agents: MCP Tool nodes, tool discovery and selection, the six built-in adapters and the MCP protocol versions."
---

# MCP Integration

MCP tools are represented by `mcp_tool` nodes and exposed to agents as callable tool definitions.

Concepts: [What is MCP?](/learn/mcp/what-is-mcp) explains the <Term id="model-context-protocol">Model Context Protocol</Term> from the start. [Too many tools](/learn/agents/too-many-tools) explains why to keep each agent's tool list short.

## Built-in MCP adapters

An adapter is how L2M reaches a server. Pick one when you [register a server](../product/mcp-server-registry.md#registering-a-server)
or configure an MCP Tool node inline.

| Adapter id | For | Notes |
|---|---|---|
| `http_mcp` | A remote server over Streamable HTTP | Secret or OAuth credentials, or per-user [delegated credentials](../product/mcp-server-registry.md#delegated-credentials). |
| `stdio_mcp` | A local server L2M starts as a child process (`npx`, `node`, `python3`, ...) | Speaks JSON-RPC over stdin and stdout; can run in a [container sandbox](../product/mcp-server-registry.md#sandboxed-stdio-servers). |
| `mock-mcp` | Demos and local checks | Time, calculator and knowledge-base tools, a tool that asks the person a question and one that asks the model for a completion, plus resources and a prompt. No network. |
| `l2m-tools` | [Built-in agent tools](../runtime/built-in-agent-tools.md) | Wikipedia, SearXNG and SerpAPI web search and Wolfram Alpha, served by the API itself. |
| `l2m-workflow` | [Workflow tools](../runtime/workflow-tool.md) | Another workflow, called by an agent as a tool. |
| `snapshot_mock` | Offline tests | A stub generated from a registered server's accepted tool snapshot; answers from a cassette or from each tool's output schema. See [Testing MCP workflows](../product/testing-mcp-workflows.md). |

The [rate limits, concurrency limits and circuit breaker](../product/mcp-server-registry.md#rate-limits-concurrency-and-the-circuit-breaker)
set on a registered server apply to servers using `http_mcp`, `stdio_mcp`, `mock-mcp` or `l2m-tools`. A community package can add more adapters with `registerMCPAdapter` (see [Community nodes](./community-nodes.md)).

## Protocol versions

`http_mcp` and `stdio_mcp` speak both MCP eras: servers that open a session with `initialize` (protocol versions up to
`2025-11-25`) and servers that speak `2026-07-28`. By default L2M opens a server with `initialize`, and switches to
`2026-07-28` by itself when a server only speaks that version. Each server's **Protocol version** setting
(`protocolMode`: `legacy`, `auto` or `modern`) and the deployment default `MCP_CLIENT_PROTOCOL_DEFAULT` change that.
See [MCP 2026-07-28 support](../product/mcp-2026-07-28.md#l2m-as-a-client).

## How it works

1. Configure MCP node endpoint/auth
2. Discover tool list from server
3. Select one, many, or all tools
4. Attach MCP node(s) to agent `tool` port
5. Agent runtime passes tool schemas to model
6. Model invokes tools dynamically during loop

[MCP tool policy](../product/mcp-tool-policy.md) decides which tools each role may call, and the
[agent loop](../runtime/agent-loop.md) explains how calls and results flow.

## Setting up an MCP Tool node for a real endpoint

Use an `MCP Tool` node attached to the Agent `tool` port.

1. Open the MCP node config.
2. Set `MCP Server Adapter` to `HTTP MCP Server (http_mcp)`.
3. Set `Endpoint` to your MCP server URL.
4. Set `Request Timeout (ms)` for the tool's latency (for large fetches use `60000` to `300000`).
5. Set `Authentication` (`None`, `Bearer` or `Basic`) and choose an `Auth Secret` if needed.
6. Click `Discover Tools`, then select the discovered tool.
7. To expose every discovered tool to the agent, set `Tools To Include` to `All discovered tools (agent decides)`.

Notes:

- `mock-mcp` is a demo adapter and always returns the demo tools `get_current_time`, `calculator` and `lookup_kb`.
- For a new adapter implementation, select `Custom Adapter ID` and register the adapter in `packages/mcp-sdk/src/index.ts`.
- If a server exposes many large tool schemas, model context limits can be hit. The runtime compacts tool schemas, truncates oversized tool outputs in conversation memory, and caps the tool metadata sent to the model.
- Every tool an MCP Tool node selects is sent to the model, so for large servers prefer `Select multiple tools`. A keyword shortlist by prompt relevance applies only to an agent with no MCP Tool or Workflow Tool node, whose tools come from its inline `mcpServers` config; Supervisor workers are always offered.

## Best practices

- Keep selected tool set minimal per workflow
- Use concise tool descriptions
- Validate discovery output before enabling `all tools`
- Register servers in the [MCP server registry](../product/mcp-server-registry.md) rather than inline, so health checks, snapshots and policy apply
