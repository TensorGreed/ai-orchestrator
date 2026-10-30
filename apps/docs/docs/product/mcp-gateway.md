---
description: "L2M as an MCP server: serve workflows and registered tools to other MCP clients through toolsets with per-client tokens, under the same tool policy and telemetry."
---

# MCP gateway

L2M is an MCP server as well as an MCP client. Any MCP client, such as an IDE agent, a desktop assistant, a command-line agent or another L2M instance, can connect to L2M and call two kinds of tools:

- **Workflow tools.** Workflows that start with an **Expose as MCP Tool** trigger (`mcp_server_trigger`). Each call runs the workflow and returns its output.
- **Gateway tools.** Tools of servers in the [MCP server registry](./mcp-server-registry), re-exposed through L2M. Each call goes through the same registry resolution, secret injection, [tool policy](./mcp-tool-policy) and telemetry as an agent's call.

Tools are grouped into **toolsets**. Each toolset has its own endpoint, and clients authenticate with per-client tokens.

```text
MCP client ──Bearer token──▶ POST /mcp/<toolset>
                              ├─ workflow tool ──▶ runs the workflow (execution history, trigger mcp_gateway)
                              └─ gateway tool  ──▶ registry server (secret injected, policy checked, telemetry)
```

## Toolsets

Toolsets live under **MCP → Toolsets** in the sidebar. Admins create and edit them; builders can read them.

| Field | Meaning |
|---|---|
| Name | Shown in the studio. |
| Slug | The endpoint path, `/mcp/<slug>`: lowercase letters, digits and dashes. Derived from the name when left empty (`-2`, `-3`, ... on a clash). |
| Description | Optional. |
| Policy project | The project whose tool policy rules apply to gateway tools. Empty means only global rules apply. |
| Enabled | A disabled toolset answers 404, and its open sessions are closed. |
| Members | Workflows with an Expose as MCP Tool trigger, and registered servers with an optional tool glob. |

### Tool names

- A **workflow tool** is named by its trigger's `toolName`, and its description and input schema come from the trigger. A workflow with several triggers gives one tool per trigger.
- A **gateway tool** is named `<server-slug>__<tool>`, for example `github__create_issue`. The server slug is the server's name in lowercase, with runs of other characters turned into `_` and a maximum of 32 characters. When two registered servers produce the same slug, the one registered later gets `_2`, then `_3`, so names stay stable as servers are added.
- If two tools in one toolset still end up with the same name, the later member gets a numeric suffix.

Descriptions and input schemas of gateway tools come from the server's **current snapshot** in the registry, so a client's `tools/list` never triggers a live `tools/list` on the upstream server. Probe the server (or wait for the scheduled probe) to pick up new tools. A server that has never been probed contributes no tools, and the toolset preview shows a warning for it.

A **tool glob** narrows a server member: `read_*` exposes only the tools whose names start with `read_`. Empty or `*` exposes all of them. Add the same server twice with different globs to combine patterns.

### Preview

The toolset detail shows the endpoint URL with a copy button and a live preview of the tools a client would see for each role, including the tools hidden by tool policy and the rule that hides them.

## Clients

Clients live under **MCP → Clients**. Admins create and revoke them; builders can list them and see their usage.

| Field | Meaning |
|---|---|
| Name | Shown in the studio, in audit events and in policy traces. |
| Toolsets | The toolsets the token may call. A request to any other toolset gets 403. |
| Role | `viewer`, `operator`, `builder` or `admin`. An admin cannot create a client with a role above their own. |
| Expires | 30 days, 90 days, 1 year or never. An expired token gets 401. |

When a client is created, its token is shown **once**, together with copy-paste configuration:

- an `mcpServers` JSON entry with `url` and `headers`, for clients configured with an `mcpServers` object;
- a `.vscode/mcp.json` entry, for editors that keep servers under a `servers` key with `"type": "http"`;
- a CLI `mcp add --transport http ... --header "Authorization: Bearer ..."` command, for command-line agents.

L2M stores only a SHA-256 hash of the token and its first characters (`l2m_mcp_<id>`), which the studio shows so you can tell tokens apart. A lost token cannot be recovered: revoke the client and create a new one.

**Revoke** takes effect at once: the token gets 401 and the client's open sessions are closed. The **Usage** panel shows the client's calls, errors and latency per tool for the last 24 hours, 7 days or 30 days, from the same telemetry table as agent calls.

## Policy subject

Tool policy evaluates a gateway call as:

- **Role**: the client's role, capped at its creator's **current** role. If the admin who created a client is later demoted to builder, the client acts as builder at most. If the creator's account is deleted, the client acts as viewer.
- **Project**: the toolset's policy project.
- **Source**: `client`, with the client's name. Policy traces show "Evaluated as builder — MCP client Team IDE".

Tools that policy denies are absent from `tools/list`. A call to one anyway returns a tool error with the policy message, and is audited as `mcp_gateway.tool_denied`. Rules can also name the client (gateway clients on the rule) and match the call's arguments: a call whose arguments a deny rule matches returns the same tool error, though the tool stays listed. A call a require-approval rule matches returns the JSON-RPC error `-32030` "approval pending" with the request id; once an admin approves it, the client retries the identical call once within `MCP_GATEWAY_APPROVAL_WINDOW_MS`. After a rejection the identical call gets `-32031` "rejected" for the same window, and a client with 20 requests waiting gets `-32029` "retry later" instead of a new one. Sampling a server asks for during a gateway call follows sampling rules scoped to the calling client. See [Gateway: approval by retry](./mcp-tool-policy.md#gateway-approval-by-retry). The per-workflow **No write tools** setting does not apply to gateway calls; it belongs to workflows. Calls to a server whose pending breaking change blocks runs fail the same way they fail for agents.

Workflow tools run as the workflow does for any trigger: the run is recorded in execution history with trigger type `mcp_gateway` and triggered by `mcp-client:<name>`, and agents inside the workflow evaluate tool policy with the client's capped role. The workflow trigger's own `authMode` and secret apply only to the legacy REST routes; on the gateway the client token is the credential.

## The endpoint

`POST /mcp/<toolset>` implements the MCP **Streamable HTTP** transport (JSON-RPC 2.0).

| | |
|---|---|
| Protocol versions | `2025-11-25` (latest), `2025-06-18` and `2025-03-26`. The server answers `initialize` with the client's version when supported, otherwise with the latest. |
| Methods | `initialize`, `notifications/initialized`, `ping`, `tools/list` (cursor pagination, 100 tools per page), `tools/call`, `notifications/cancelled`. |
| Sessions | `initialize` returns an `Mcp-Session-Id` header; every later request must send it. `DELETE /mcp/<toolset>` with the header ends the session. Sessions are bound to the client and toolset that opened them. |
| Responses | `application/json`, or a `text/event-stream` response when the request carries `_meta.progressToken` and the `Accept` header allows SSE. The stream carries `notifications/progress` messages and then the response. |
| Batches | Only in protocol version `2025-03-26`, which allowed them. Later versions get 400. |
| `GET` | 405. The gateway offers no server-initiated stream. |
| Errors | A tool that fails returns a result with `isError: true`. Protocol problems (unknown method, unknown tool, bad params) are JSON-RPC errors. |

**Progress.** A workflow tool reports one progress step per completed node. **Cancellation.** `notifications/cancelled` for an in-flight `tools/call` cancels the workflow run (it ends as `canceled` in execution history) or, for a gateway tool, closes the upstream connection of that session; for a stdio server that stops the child process, and the next call starts a new one.

**Sessions** live in the memory of the API instance that created them. Behind a load balancer, route a client's requests to one instance (sticky sessions; see [MCP gateway sessions](../operations/cluster.md#mcp-gateway-sessions) for a balancer setup that learns the `Mcp-Session-Id` from the response); a request that lands elsewhere gets 404 and a well-behaved client starts a new session. A session closes after `MCP_GATEWAY_SESSION_IDLE_MS` without requests (default 30 minutes), and at most `MCP_GATEWAY_MAX_SESSIONS` (default 500) are open at once: past that the least recently used idle session is closed, and with none idle a new `initialize` gets 503.

stdio servers started for gateway calls belong to the client session that started them and are stopped when the session ends, idles out, or its client or toolset is revoked, disabled or deleted.

## Telemetry and audit

Every `tools/call` writes a row to `mcp_tool_calls` with `source = gateway` and the client id, so the server page's Tools table and the client's Usage panel include it. Workflow tool calls are recorded under the adapter id `workflow` with the run's execution id.

Audit events:

| Event | When |
|---|---|
| `mcp_gateway.session_started` / `session_ended` | A client opens or ends a session (ended includes the reason: `deleted`, `idle`, `evicted`, `revoked`, `toolset_removed` (slug changed, disabled or deleted), `shutdown`). |
| `mcp_gateway.tool_called` | Every workflow tool call, every write-tool call, every failed call, and read-only calls per `MCP_GATEWAY_AUDIT_READ_ONLY_CALLS`. |
| `mcp_gateway.tool_denied` | A call to a tool that policy hides, or whose arguments a deny rule matches. |
| `mcp_gateway.approval_requested` / `approval_decided` / `approval_used` | A require-approval rule held a call back, an admin approved or rejected it, the approved retry went through. |
| `mcp_gateway.approval_refused_rejected` / `approval_capped` | The first identical retry after a rejection was refused; a client with too many requests waiting was refused a new one (once per client per approval window). |
| `mcp_toolset.created` / `updated` / `deleted` / `member_added` / `member_removed` | Toolset changes. |
| `mcp_client.created` / `revoked` | Client changes. Metadata carries the token prefix, never the token. |

`MCP_GATEWAY_AUDIT_READ_ONLY_CALLS` is `first_per_session` by default: the first call to each read-only tool in a session is audited, later ones only in telemetry. Set `all` to audit every call or `none` to rely on telemetry for read-only tools.

## Security

- **Tokens.** Send the token only over HTTPS outside a trusted network. It is shown once, stored hashed, and never appears in API responses, logs or audit events. Give each client its own token with the narrowest role and toolsets it needs, and an expiry.
- **Origin check.** Browsers can be tricked into sending requests to a local server through DNS rebinding. The endpoint therefore rejects requests whose `Origin` header is not allowed with 403. Requests without an `Origin` (desktop, IDE and CLI clients) are accepted, as are `WEB_ORIGIN`, `MCP_GATEWAY_PUBLIC_URL` and the origins in `MCP_GATEWAY_ALLOWED_ORIGINS`. The `Host` header is not trusted for this check. CORS on `/mcp/*` follows the same list and never allows credentials.
- **Binding.** For local use, bind the API to `127.0.0.1` (`API_HOST`). On a shared host, put it behind a reverse proxy that terminates TLS, and set `MCP_GATEWAY_PUBLIC_URL` to the public base URL so the studio shows the right endpoint.
- **Secrets.** Gateway tools use the registry server's secret through the secret service; the value is never sent to the client, and if an upstream server echoes it back the gateway replaces it with `[REDACTED]`.
- **Self-hosted.** The gateway makes no outbound calls of its own beyond the registered servers you configure.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_GATEWAY_ALLOWED_ORIGINS` | empty | Extra browser origins allowed to call the endpoint, comma-separated. |
| `MCP_GATEWAY_PUBLIC_URL` | empty | Base URL clients use; shown in endpoint URLs and snippets. Empty means the browser's origin. |
| `MCP_GATEWAY_SESSION_IDLE_MS` | `1800000` | Idle time before a session closes (minimum 10000). |
| `MCP_GATEWAY_MAX_SESSIONS` | `500` | Open sessions across all clients. |
| `MCP_GATEWAY_AUDIT_READ_ONLY_CALLS` | `first_per_session` | `all`, `first_per_session` or `none`. |
| `MCP_GATEWAY_APPROVAL_WINDOW_MS` | `900000` | How long after an approval the client can retry the identical call, once; also how long after a rejection the identical call is refused (10000 to 604800000). |

## API

Admin for writes, builder for reads. See the [endpoint reference](../api/endpoints#mcp-gateway).

## Related

- [Expose a workflow as an MCP tool](../runtime/workflow-as-mcp-tool)
- [MCP server registry](./mcp-server-registry)
- [MCP tool policy](./mcp-tool-policy)
