---
title: "MCP integration: connect MCP tools to agents"
description: "How MCP tools reach L2M agents: MCP Tool nodes, the six built-in adapters (HTTP, stdio, mock, built-in tools, workflows, snapshots) and protocol versions."
---

# MCP Integration

MCP tools are represented by `mcp_tool` nodes and exposed to agents as callable tool definitions.

Concepts: [What is MCP?](/learn/mcp/what-is-mcp) explains the <Term id="model-context-protocol">Model Context Protocol</Term> from the start.

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

## Best practices

- Keep selected tool set minimal per workflow
- Use concise tool descriptions
- Validate discovery output before enabling `all tools`
- Register servers in the [MCP server registry](../product/mcp-server-registry.md) rather than inline, so health checks, snapshots and policy apply
