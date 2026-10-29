---
title: "Self-hosted MCP gateway: one governed endpoint for your MCP tools"
description: "Run a self-hosted MCP gateway with L2M: group tools into toolsets, give each MCP client its own token and role, and apply the same tool policy and telemetry."
---

# Run a self-hosted MCP gateway

An **MCP gateway** sits between MCP clients (IDE agents, desktop assistants, command-line agents) and the MCP servers they call. Instead of every client holding its own connection and credentials for every server, clients connect to one endpoint. The gateway decides which tools each client sees, injects the server credentials itself, checks every call against policy and records what happened.

You need one when more than a couple of people or agents call the same MCP servers: credentials are copied into many config files, nobody can say who called which tool, and there is no single place to switch a tool off.

L2M is an MCP client and an MCP server at the same time, so it can be that gateway. It runs on your own infrastructure; the gateway makes no outbound calls of its own beyond the servers you register. This guide sets one up end to end.

## What you will build

```text
IDE agent ─token─▶ /mcp/support ─▶ github__search_issues  (registry server)
CLI agent ─token─▶ /mcp/support ─▶ triage_ticket          (an L2M workflow)
```

- A **toolset** named `support`, served at `/mcp/support`, holding a registered server's read tools and one workflow.
- A **client** with its own token, a role and an expiry.
- **Policy** that hides write tools from that client, and **telemetry** for every call.

You need an admin account. Builders can read toolsets and clients but not change them.

## 1. Register the servers once

Gateway tools come from the [MCP server registry](../product/mcp-server-registry.md), so each upstream server is configured once:

1. Open **MCP → Servers** and choose **+ Register server**.
2. Pick the adapter: `http_mcp` for a server reachable over HTTP, `stdio_mcp` to start a local process. Start from a preset if one fits.
3. Fill in the connection JSON and pick the server's secret from the Secrets store. The secret value never goes into the connection JSON and is never returned by the API.
4. Save. The server is probed straight away, and its tool list is stored as a snapshot.

The gateway lists tools from that snapshot, so a client's `tools/list` never starts or calls the upstream server. A server that was never probed contributes no tools. If the server already lives in your team's MCP client config files, **Import config** on the same page can register it for you (see [MCP onboarding](../product/mcp-onboarding.md)).

## 2. Create a toolset

Open **MCP → Toolsets** and create one:

| Field | Example | Notes |
| --- | --- | --- |
| Name | Support | Shown in the studio. |
| Slug | `support` | The endpoint becomes `/mcp/support`. Derived from the name when left empty. |
| Policy project | Support | Whose [tool policy](../product/mcp-tool-policy.md) rules apply to gateway tools. Empty means only global rules. |
| Members | GitHub server with glob `search_*`; the `triage_ticket` workflow | A glob narrows a server to some of its tools. Empty or `*` exposes all of them. |

Gateway tools are named `<server-slug>__<tool>`, for example `github__search_issues`. A workflow becomes a tool when it starts with an **Expose as MCP Tool** trigger; its `toolName`, description and input schema come from the trigger (see [Expose a workflow as an MCP tool](../runtime/workflow-as-mcp-tool.md)).

The toolset page shows the endpoint URL and a live preview of the tools each role would see, including tools hidden by policy and the rule that hides them.

## 3. Create a client and connect it

Open **MCP → Clients** and create a client for each person, team or agent:

- **Toolsets**: the ones this token may call. Any other toolset answers 403.
- **Role**: `viewer`, `operator`, `builder` or `admin`, never above your own. Tool policy evaluates the client with this role, capped at its creator's current role.
- **Expires**: 30 days, 90 days, 1 year or never.

The token is shown **once**, with copy-paste configuration for three kinds of client. For a client configured with an `mcpServers` object it looks like this:

```json
{
  "mcpServers": {
    "l2m-support": {
      "url": "https://l2m.example.com/mcp/support",
      "headers": { "Authorization": "Bearer l2m_mcp_…" }
    }
  }
}
```

The same dialog gives a `.vscode/mcp.json` entry and an `mcp add --transport http …` command line. L2M stores only a hash of the token; a lost token cannot be recovered, so revoke the client and create a new one.

To check the endpoint without a client, open a session by hand. The `Mcp-Session-Id` header in the answer goes on every later request:

```bash
curl -si https://l2m.example.com/mcp/support \
  -H "Authorization: Bearer $L2M_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

## 4. Govern what clients can call

Gateway calls go through the same tool policy as agent calls:

- A **deny rule** on a tool, server or annotation (for example every destructive tool for `operator`) removes the tool from the client's `tools/list`. A call to it anyway returns a tool error and is audited as `mcp_gateway.tool_denied`.
- Rules are scoped by the toolset's **policy project** and the client's **role**, so one toolset can serve a viewer client and a builder client with different tool sets.

[Govern MCP tools](./govern-mcp-tools.md) walks through writing those rules. Note that the per-workflow **No write tools** switch does not apply to gateway calls; use a rule instead.

## 5. Watch usage

Every `tools/call` through the gateway is written to the same telemetry table as agent calls, with `source = gateway` and the client:

- the client's **Usage** panel shows calls, errors and latency per tool for 24 hours, 7 days or 30 days;
- the server page's **Tools** table and **MCP → Overview** include gateway calls;
- the audit log records sessions, write-tool calls, failed calls, denied calls and every change to toolsets and clients.

**Revoke** takes effect at once: the token gets 401 and its open sessions close.

## How it works

- The endpoint `POST /mcp/<toolset>` implements the MCP **Streamable HTTP** transport (JSON-RPC 2.0), protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`.
- Each call to a gateway tool resolves the registry server, injects its secret through the secret service, checks policy and records telemetry. If an upstream server echoes the secret back, the gateway replaces it with `[REDACTED]`.
- A workflow tool runs the workflow (its published version when it has one) and records the run in execution history with trigger type `mcp_gateway`.
- Requests from browsers are refused unless their `Origin` is allowed, which blocks DNS-rebinding attacks on a local gateway. Desktop, IDE and CLI clients send no `Origin` and are accepted.

## Production checklist

- Put the API behind a reverse proxy that terminates TLS, and set `MCP_GATEWAY_PUBLIC_URL` so the studio shows the public endpoint in its snippets.
- For local use only, bind the API to `127.0.0.1` with `API_HOST`.
- Sessions live in the memory of the instance that created them: behind a load balancer, use sticky sessions.
- Give every client its own token, the narrowest role and toolsets, and an expiry.

## What it does not do

- No server-initiated stream: `GET /mcp/<toolset>` answers 405.
- Tools come from the last probe. New upstream tools appear after the next scheduled probe or a **Probe now**.
- It does not host anything for you: the gateway, the registry and the telemetry all run in your L2M deployment.

## Next steps

- Reference: [MCP gateway](../product/mcp-gateway.md), [MCP server registry](../product/mcp-server-registry.md), [MCP tool policy](../product/mcp-tool-policy.md)
- Guides: [Govern MCP tools](./govern-mcp-tools.md), [Test MCP servers in CI](./test-mcp-servers-in-ci.md)
- See the MCP pages of the studio in the [live demo](https://lsquarem.com/demo/){target="_self"}, or [build your first MCP agent](../getting-started/build-your-first-mcp-agent.md)
