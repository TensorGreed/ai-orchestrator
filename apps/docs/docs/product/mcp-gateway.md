---
title: "MCP gateway: serve workflows and tools to MCP clients"
description: "L2M as an MCP server: serve workflows and tools to MCP clients through toolsets with per-client tokens, tool policy, budgets and optional rate limits."
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
| Track outside content per session | Off by default. When on, each client session remembers what its calls returned, and later calls in the session are checked with those labels (see below). |
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

Clients live under **MCP → Clients**. Admins create, rotate and revoke them; builders can list them and see their usage.

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

**Revoke** takes effect at once: the token gets 401 and the client's open sessions are closed.

### Rotating a client's token

**Rotate** (or `POST /api/mcp/clients/:id/rotate` with `{ "graceHours": 24 }`) issues a new token, shown once, and
keeps the old token working for the grace window: 24 hours by default, 0 to 168, 0 stops it at once, and never past the
client's own expiry. The client keeps its name, role, toolsets, limits, network settings and open sessions: a session
keeps working with either token until the window ends, then the old token gets 401 ("expired"). The client's row shows
the previous token's prefix and when it stops working.

While an old token is still in its window, another rotation is refused (`409 { code: "rotation_pending" }`), so a second
click never cuts off the first token's callers without warning. Rotate with `graceHours: 0` to end every old token now,
for example when the new token leaked. Two rotations at the same moment, on one instance or two, apply once (the other
gets `rotation_conflict` or `rotation_pending`). Rotating needs step-up when it is on (`mcp_client.rotate`). A client
that expires within 7 days raises the `credential.expiring` notification (see
[Expiry warnings](../security/service-accounts.md#expiry-warnings)). The **Usage** panel shows the client's calls, errors and latency per tool for the last 24 hours, 7 days or 30 days, from the same telemetry table as agent calls.

## Policy subject

Tool policy evaluates a gateway call as:

- **Role**: the client's role, capped at its creator's **current** role. If the admin who created a client is later demoted to builder, the client acts as builder at most. If the creator's account is deleted, the client acts as viewer.
- **Project**: the toolset's policy project.
- **Source**: `client`, with the client's name. Policy traces show "Evaluated as builder — MCP client Team IDE".

Tools that policy denies are absent from `tools/list`. A call to one anyway returns a tool error with the policy message, and is audited as `mcp_gateway.tool_denied`. Rules can also name the client (gateway clients on the rule) and match the call's arguments: a call whose arguments a deny rule matches returns the same tool error, though the tool stays listed. A call a require-approval rule matches returns the JSON-RPC error `-32030` "approval pending" with the request id; once an admin approves it, the client retries the identical call once within `MCP_GATEWAY_APPROVAL_WINDOW_MS`. After a rejection the identical call gets `-32031` "rejected" for the same window, and a client with 20 requests waiting gets `-32029` "retry later" instead of a new one. Sampling a server asks for during a gateway call follows sampling rules scoped to the calling client. See [Gateway: approval by retry](./mcp-tool-policy.md#gateway-approval-by-retry). The per-workflow **No write tools** setting does not apply to gateway calls; it belongs to workflows. Calls to a server whose pending breaking change blocks runs fail the same way they fail for agents.

Workflow tools run as the workflow does for any trigger: the run is recorded in execution history with trigger type `mcp_gateway` and triggered by `mcp-client:<name>`, and agents inside the workflow evaluate tool policy with the client's capped role. The workflow trigger's own `authMode` and secret apply only to the legacy REST routes; on the gateway the client token is the credential.

## The endpoint

`POST /mcp/<toolset>` implements the MCP **Streamable HTTP** transport (JSON-RPC 2.0). The table below describes session-based clients (protocol versions up to `2025-11-25`). With `MCP_GATEWAY_MODERN_PROTOCOL=on` the same endpoint also serves MCP `2026-07-28` clients, without sessions: see [MCP 2026-07-28 support](./mcp-2026-07-28.md#the-mcp-gateway).

| | |
|---|---|
| Protocol versions | `2025-11-25`, `2025-06-18` and `2025-03-26`. The server answers `initialize` with the client's version when supported, otherwise with `2025-11-25`. `2026-07-28` is served per request when `MCP_GATEWAY_MODERN_PROTOCOL=on`. |
| Methods | `initialize`, `notifications/initialized`, `ping`, `tools/list` (cursor pagination, 100 tools per page), `tools/call`, `notifications/cancelled`. |
| Sessions | `initialize` returns an `Mcp-Session-Id` header; every later request must send it. `DELETE /mcp/<toolset>` with the header ends the session. Sessions are bound to the client and toolset that opened them. |
| Responses | `application/json`, or a `text/event-stream` response when the request carries `_meta.progressToken` and the `Accept` header allows SSE. The stream carries `notifications/progress` messages and then the response. |
| Batches | Only in protocol version `2025-03-26`, which allowed them. Later versions get 400. |
| `GET` | 405. The gateway offers no server-initiated stream. |
| Errors | A tool that fails returns a result with `isError: true`. Protocol problems (unknown method, unknown tool, bad params) are JSON-RPC errors. |

**Progress.** A workflow tool reports one progress step per completed node. **Cancellation.** `notifications/cancelled` for an in-flight `tools/call` cancels the workflow run (it ends as `canceled` in execution history) or, for a gateway tool, closes the upstream connection of that session; for a stdio server that stops the child process, and the next call starts a new one.

**Sessions** live in the memory of the API instance that created them. Behind a load balancer, route a client's requests to one instance (sticky sessions; see [MCP gateway sessions](../operations/cluster.md#mcp-gateway-sessions) for a balancer setup that learns the `Mcp-Session-Id` from the response); a request that lands elsewhere gets 404 and a well-behaved client starts a new session. A session closes after `MCP_GATEWAY_SESSION_IDLE_MS` without requests (default 30 minutes), and at most `MCP_GATEWAY_MAX_SESSIONS` (default 500) are open at once: past that the least recently used idle session is closed, and with none idle a new `initialize` gets 503.

stdio servers started for gateway calls belong to the client session that started them and are stopped when the session ends, idles out, or its client or toolset is revoked, disabled or deleted.

**Tool list changes (MCP 2026-07-28).** With `MCP_GATEWAY_MODERN_PROTOCOL=on`, `server/discover` declares `tools.listChanged: true`, and a client can open a `subscriptions/listen` stream (`Accept: text/event-stream`) with `notifications: { toolsListChanged: true }`. The acknowledgment echoes `toolsListChanged: true` (prompts and resources are not served, so they are left out), and the stream then gets `notifications/tools/list_changed` whenever the list that client's `tools/list` returns changes: a toolset edit, a tool rule or classification that hides or shows a tool for the client's role, a change to the client or the role of the user who created it, a workflow tool saved or published, or a member server's tools changing as its probes see them. Edits that leave the client's list as it was send nothing. Changes nothing announces (rules written by background jobs, rules whose conditions depend on time) are found by the periodic check. Changes made on any instance reach streams on every instance over the cluster bus, and each stream's list is also re-checked every `MCP_GATEWAY_LISTEN_CHECK_MS` in case a message was lost. A stream whose client is revoked or no longer scoped to the toolset, or whose toolset is disabled or deleted, ends with a `complete` result. Streams count only against `MCP_GATEWAY_LISTEN_MAX_PER_CLIENT` and end after `MCP_GATEWAY_LISTEN_MAX_MS` (clients reconnect). Session-based clients are unchanged: `initialize` still declares `listChanged: false`.

### Outside content per session

A gateway call has no workflow run around it, so on its own it carries no [data labels](./data-labels-and-destinations.md). On a toolset without tracking, a "data has label" condition never matches a gateway call, and a "data lacks label" condition on a deny or approval rule matches every one (it fails closed). Turn on **Track outside content per session** on a toolset to give its clients' calls labels.

With it on, each client session keeps a set of labels that starts empty (the client's own request counts as `user`) and only grows:

- After a call to a server tool, later calls in the session carry `untrusted_external`. Every server tool's result counts as outside content, as it does in runs. A server whose secret is flagged **Sensitive output** adds `sensitive` too.
- After a call to a workflow tool, later calls carry the labels of the run's output: `untrusted_external` when it came from outside, `sensitive` from the workflow's declared sources, and data class names only when the run tracked them. If the run's labels did not come back (a run on a queue worker that does not send them), the result counts as outside content, and as `sensitive` when one of the workflow's nodes, or a node of a sub-workflow it calls, declares a sensitive source. A sub-workflow that cannot be loaded, or one nested more than 10 levels deep, counts as sensitive.
- A failed or cancelled call whose server was reached counts as outside content. A call that a rule denied, that waits for approval, or that the rate limit refused before it reached the server adds nothing.
- Nothing the client sends (arguments, `_meta`, headers) is read as a label.

**What is not checked.** Server tool results are never scanned. So a gateway session carries `sensitive` only from a flagged secret or a workflow tool's run, and data class names only from workflow tool runs that tracked them. A `sensitive` or data class the session does not hold counts as *not checked*, not as absent: a "data lacks label" condition on it never lets an allow rule through (so it cannot carve an exception out of a deny), and it still matches a deny or approval rule. A "data has label" condition on a class the session does not hold does not match, so a rule such as "deny when `email` is present" does not fire after a client reads e-mail addresses from a server. A session keeps at most 100 data class names. Tool names and descriptions from `tools/list` are outside content too, but listing tools never raises the mark: only calls do.

The labels never go down during a session; ending the session clears them. A client can end its session and start a new one at any time. The new one starts clean, except from the labels its token collected without a session (see below). The mark protects an agent that means well from content it was shown; it is not a control against a client that sets out to avoid it. For that, use the client's role and rules that do not depend on labels.

The labels are passed to the [tool rules](./mcp-tool-policy.md) like a run's labels, so the safety presets, shadow mode and simulation work the same for gateway calls. A workflow tool's run also starts with them, and records them on its trigger, so a retry or replay of that run starts from them too. The first time a session carries outside content or sensitive data is audited once as `mcp_gateway.session_labels_raised`. An approval request records the labels the held call had, in its audit event and on the request itself: **Gateway approvals** on the Policies page shows them as chips beside the rule (requests stored before this release show none). Each client's **Sessions** panel shows each open session's labels (**Refresh** reads them again). Each call's labels are recorded on its telemetry row, and the simulator reads them as the gateway does; calls on toolsets that do not track stay undetermined.

If you turn tracking on while sessions are open, a session that already made calls is treated as having seen outside content. The labels live with the session in the memory of the instance that opened it, and end with it.

**Clients without sessions.** A client that speaks MCP `2026-07-28` (served when `MCP_GATEWAY_MODERN_PROTOCOL=on`) sends no session id. Its labels are kept per client token and toolset instead (and per user, when the token acts for one), in the database, so every instance checks its calls with the same labels. The client cannot clear them: nothing it sends names them, and they survive a restart of the instance and a call answered by another one. They end `MCP_GATEWAY_SESSION_IDLE_MS` after the client's last call (the same idle time as a session), when the client is revoked, or when the toolset is deleted. If the labels cannot be read from the database, the call is refused with a tool error asking the client to try again; if a result's labels cannot be written, the result is not sent and the client gets the same kind of error. Results returned while the toolset did not track are noted the same way, so turning tracking on counts them on every instance. The **Sessions** panel lists these clients as *Stateless caller (2026-07-28)* next to the sessions, with their labels. The same client token can still open a session with `initialize`; on a tracking toolset that session starts from the labels collected before it opened (including results noted while the toolset did not track, which then count as outside content for both), instead of starting clean. If they cannot be read, `initialize` gets HTTP 503 and no session is opened. After that the session keeps its own labels, as every session does: what the client collects without the session later is not added to it.

### Content rules on the gateway

[Content rules](./content-rules.md) can check gateway calls too. They are off until you pick a rule set, enforce one on the project or set up destination rules: with none of those, the gateway works exactly as before.

- **Toolset.** In a toolset's detail, under **Content rules**, an admin picks a rule set. It checks every client's calls to that toolset's tools.
- **Client.** In the **Clients** view, a client's **Governance** section has its own **Content rules** picker. It checks that client's calls on all its toolsets, on top of the toolset's rule set.
- **Stacking.** The rule sets run in this order: the toolset project's enforced rule set, the toolset's rule set, the client's rule set, then the deployment's [destination rules](./data-labels-and-destinations.md). All of them run and the strictest action wins, so a client's rule set can add checks but never loosen the toolset's. The instance default rule set (`GUARD_AUTO_APPLY`) does not apply to gateway calls.
- **The project's enforced rule set and the deployment's destination rules** apply to gateway calls on their own, with no toolset or client rule set. An admin who enforces a rule set on a project gets it on that project's toolsets too. (Before this release, both applied only once the toolset or the client had a rule set; set `GATEWAY_RULES_WITHOUT_BINDING=false` to keep that.)

Each tool call, server or workflow tool, is checked twice:

1. **Arguments**, before the server or the workflow sees them (the `tool_arguments` channel). A block stops the call there: the server is not called and the workflow does not run. For a server tool that a [tool rule](./mcp-tool-policy.md) holds for approval, the arguments are checked before the approval is asked for or used, so a call the rules block never takes up an approval.
2. **Result**, on what comes back (the `tool_result` channel): the server's result after the gateway removes any secret the server echoed back, or the workflow run's output or error. Redactions and masks apply to what the client gets.

A blocked call answers with a tool error such as `Blocked by content rules: prompt injection`. The reason names the kind of finding, never the content. A rule set action that would wait for a review or an approval also blocks, because nobody can approve a gateway call while the client waits; the picker warns when the chosen rule set has such actions. A rule set in shadow mode only records what it would have done. Each rule set's latency budget and fail-closed setting apply as they do in runs. If the gateway cannot read the toolset's and client's rule set choices (a database error), it refuses the call with a short tool error rather than send it unchecked.

Every check is recorded in the rule events with the placement `gateway`, the tool's gateway name as the node and an execution id that starts with `mcpgw_`. For a server tool that the server answered, this is the same id as the call's telemetry row. A call blocked on its arguments writes no telemetry row (as a call a tool rule denies): it shows only in the rule events and as `mcp_gateway.guard_blocked` in the audit log. On the **Security** page, set **Source** to **MCP gateway calls** to see only these; they have no run to open. Events of server tool calls have no workflow, so only admins see them; events of workflow tool calls name the workflow. A client's **Sessions** panel shows how many calls the content rules blocked in each open session.

**Inside a workflow tool's run.** The run also applies the toolset's and client's rule sets, after the workflow's own (they only add checks), wherever it uses content rules: its Content Rules nodes and agents. A workflow with neither is still checked on its arguments and result at the gateway, but nothing in between. The run records which rule set versions it got, so a resumed run (after an approval), a retry, a replay and a golden run saved from it apply the same versions, also when queue workers run it. If one of those versions has since been deleted, the run fails its rule checks rather than run without it. Runs started any other way are not affected.

**Not checked.** When a server asks the gateway's model for a completion during a call (MCP sampling), content rules do not check that prompt or the model's answer, as in runs. Sampling is off unless a [tool rule](./mcp-tool-policy.md) allows it.

Changing a toolset's or client's rule set is audited as `guard.binding.updated`. Deleting a toolset or revoking a client removes its rule set choice.

## Budgets and rate limits

Both are optional. With no budget and no rate limit, the gateway answers as before and reads neither for a call.

### Budgets

[Budgets](./budgets.md) count gateway usage:

- **Per client.** A budget with the scope **MCP client** counts that client's usage: the runs its workflow tool calls start, and the model sampling its server tool calls use (the sampling cost is priced with the model prices and stored on the call's telemetry row). Runs recorded before this release name the client only by name: they still count, by the client's current name and from its creation on. Renaming a client drops those older runs from its budgets, and two clients that existed under the same name before this release both count them. A run that waits on an approval stays the client's after the approval.
- **Per project.** A toolset's gateway usage also counts toward the budget of the toolset's **policy project**, even when its workflows live in other projects.
- **Global.** A global budget counts every run and all gateway sampling.

Before the tool policy runs, each `tools/call` is checked against the `block` budgets of the client, the toolset's project and the deployment, and for a workflow tool also the budgets of the workflow and its project. A workflow tool's run is not checked again when it starts. When one is used up, the call is refused with JSON-RPC error `-32032` and a message such as `Budget "IDE agents" exceeded for the current month.` Its `data` carries the `budgetId`, the `period`, its start and `retryAfterSeconds` (until the period ends). The server is not called and no run starts. A `warn` budget never refuses a call; it sends its alerts as for runs.

A call that starts under the cap may take it over, and calls sent together (one batch, or several sessions at once) are checked before any of them ends, so usage can pass a budget by about one batch. The next call is refused. Budgets are read from a copy each instance refreshes every 2 seconds and right after an edit on that instance, so a budget created on another instance applies within 2 seconds. If the budgets cannot be read at all, calls are refused with a tool error rather than sent unchecked.

A client's **Governance** section lists every budget that applies to it, each labelled by scope (**This client**, **Project …**, **Deployment**), with what it counted this period; a used-up block budget is marked as refusing the client's calls. Budgets themselves are set in **Settings**, **FinOps**.

### Rate limits

An admin can cap how fast a client calls tools:

- **Calls per minute**, with an optional **Burst**: how many calls may arrive at once before the per-minute rate applies (the per-minute number when empty).
- **Calls at once**: calls in flight at the same time.

Set a client's own limit in its **Governance** section, or a **Default rate limit** in a toolset's detail. A toolset's default applies to each of its clients separately, for its calls through that toolset. A client's own limit replaces the toolset default as a whole (fields are not mixed) and is one allowance across all its toolsets. Leave a field empty for no limit there.

Every `tools/call` counts, including each call of a batch. A call over the limit is refused at once, never queued, with JSON-RPC error `-32029` (retry later). Its `data` has the `reason` (`rate_limited` or `concurrency_limited`) and `retryAfterMs`. Refusals are audited as `mcp_gateway.rate_limited` at most once per session per minute, and write no telemetry row.

In [cluster mode](../operations/cluster.md) the per-minute count is shared by all instances through the database, the same way as the sign-in and webhook rate limits: a client gets its allowance once, not once per instance. The shared count uses fixed windows: with a burst up to the per-minute rate, a window of `60 s × burst / calls per minute` holding the burst; with a larger burst, one minute holding the per-minute number (so a burst above one minute's calls applies on a single instance only, and a client that used its allowance waits at most a minute). The window is rounded up to a whole millisecond, so at extreme rates (above about 60,000 calls a minute with a burst of 1) the shared limit is lower than the one you set, and the database round trip is longer than the window anyway. As with any fixed window, up to twice a window's calls can pass around a window boundary. If the database cannot be reached, each instance counts on its own until it can. **Calls at once** is counted per instance, because a session's calls run on the instance that holds the session.

Changing a client's name or rate limit is audited as `mcp_client.updated`; a toolset's default is part of `mcp_toolset.updated`.

## Telemetry and audit

Every `tools/call` writes a row to `mcp_tool_calls` with `source = gateway`, the client id and the toolset id, so the server page's Tools table and the client's Usage panel include it. Workflow tool calls are recorded under the adapter id `workflow` with the run's execution id.

Audit events:

| Event | When |
|---|---|
| `mcp_gateway.session_started` / `session_ended` | A client opens or ends a session (ended includes the reason: `deleted`, `idle`, `evicted`, `revoked`, `toolset_removed` (slug changed, disabled or deleted), `shutdown`). |
| `mcp_gateway.tool_called` | Every workflow tool call, every write-tool call, every failed call, and read-only calls per `MCP_GATEWAY_AUDIT_READ_ONLY_CALLS`. |
| `mcp_gateway.tool_denied` | A call to a tool that policy hides, or whose arguments a deny rule matches. |
| `mcp_gateway.approval_requested` / `approval_decided` / `approval_used` | A require-approval rule held a call back, an admin approved or rejected it, the approved retry went through. |
| `mcp_gateway.approval_refused_rejected` / `approval_capped` | The first identical retry after a rejection was refused; a client with too many requests waiting was refused a new one (once per client per approval window). |
| `mcp_toolset.created` / `updated` / `deleted` / `member_added` / `member_removed` | Toolset changes. |
| `mcp_toolset.session_tracking_changed` | **Track outside content per session** was turned on or off. |
| `mcp_gateway.guard_blocked` | Content rules blocked a server tool call's arguments or result (with the client, the tool, the channel, the finding kinds and the rule sets; never the content). |
| `mcp_gateway.session_labels_raised` | A session on a tracking toolset carried outside content or sensitive data for the first time (once per session, with the client and the tool). |
| `mcp_client.created` / `updated` / `revoked` / `rotated` | Client changes (updated: its name or rate limit, with the previous values; rotated: the old and new token prefixes and the grace window). Metadata carries the token prefix, never the token. |
| `mcp_gateway.rate_limited` / `budget_blocked` | A rate limit or a used-up block budget refused a call (once per session per minute). |
| `mcp_client.network_updated` | A client's address list or certificate pin changed, with the values before and after. |
| `mcp_gateway.client_certificate_refused` | A client that pins certificates called without a matching one (at most once a minute per client, address and reason). |

`MCP_GATEWAY_AUDIT_READ_ONLY_CALLS` is `first_per_session` by default: the first call to each read-only tool in a session is audited, later ones only in telemetry. Set `all` to audit every call or `none` to rely on telemetry for read-only tools.

## Security

- **Tokens.** Send the token only over HTTPS outside a trusted network. It is shown once, stored hashed, and never appears in API responses, logs or audit events. Give each client its own token with the narrowest role and toolsets it needs, and an expiry.
- **Origin check.** Browsers can be tricked into sending requests to a local server through DNS rebinding. The endpoint therefore rejects requests whose `Origin` header is not allowed with 403. Requests without an `Origin` (desktop, IDE and CLI clients) are accepted, as are `WEB_ORIGIN`, `MCP_GATEWAY_PUBLIC_URL` and the origins in `MCP_GATEWAY_ALLOWED_ORIGINS`. The `Host` header is not trusted for this check. CORS on `/mcp/*` follows the same list and never allows credentials.
- **Addresses and certificates.** A client can be limited to address ranges and can be required to present a client certificate, forwarded by your TLS proxy, on top of its token (the client's **Network** panel); the whole `/mcp/*` endpoint can be limited with `NETWORK_ALLOW_MCP_GATEWAY`. See [Network controls](../security/network-controls.md).
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
| `MCP_GATEWAY_LISTEN_MAX_MS` | `600000` | MCP 2026-07-28: a `subscriptions/listen` stream ends with a `complete` result after this long. |
| `MCP_GATEWAY_LISTEN_MAX_PER_CLIENT` | `4` | MCP 2026-07-28: open listen streams per client on one instance. |
| `MCP_GATEWAY_LISTEN_CHECK_MS` | `30000` | MCP 2026-07-28: how often a stream that asked for `toolsListChanged` has its tool list re-checked, besides the change hints; `0` = hints only. |
| `MCP_GATEWAY_APPROVAL_WINDOW_MS` | `900000` | How long after an approval the client can retry the identical call, once; also how long after a rejection the identical call is refused (10000 to 604800000). |
| `MCP_GATEWAY_MODERN_PROTOCOL` | `off` | `on` also serves MCP `2026-07-28` clients, without sessions. See [MCP 2026-07-28 support](./mcp-2026-07-28.md#the-mcp-gateway). |
| `MCP_GATEWAY_LIST_TTL_MS` | `60000` | With modern mode on: how long `2026-07-28` clients may cache `tools/list` and `server/discover` results (0 to 86400000). |
| `MCP_GATEWAY_LISTEN_MAX_MS` | `600000` | With modern mode on: a `subscriptions/listen` stream ends gracefully after this long (1000 to 86400000). |
| `MCP_GATEWAY_LISTEN_MAX_PER_CLIENT` | `4` | With modern mode on: open `subscriptions/listen` streams per client on one instance (1 to 1000). |

## API

Admin for writes, builder for reads. See the [endpoint reference](../api/endpoints#mcp-gateway).

## Related

- [Expose a workflow as an MCP tool](../runtime/workflow-as-mcp-tool)
- [MCP server registry](./mcp-server-registry)
- [MCP tool policy](./mcp-tool-policy)
- [MCP 2026-07-28 support](./mcp-2026-07-28)
- Concepts: [LLM gateway vs MCP gateway](../learn/operations/llm-gateway-vs-mcp-gateway), [MCP gateway](../glossary/mcp-gateway) (glossary)
