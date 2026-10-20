# MCP server registry

The **MCP servers** page keeps one list of every MCP server your agents call. Each entry is probed on a schedule, its tool schemas are kept as history, and a schema change that could break existing callers is flagged before it reaches a run. Everything lives in your own deployment: the registry is a table in your L2M database and the probes run in your API process.

## Why register a server

An MCP Tool node can carry its own adapter, connection and secret. That works for one workflow, but it means the same server is configured in many places and nobody notices when it goes down or changes a tool. A registered server is configured once:

- **One connection, many workflows.** Nodes point at the registry entry. Editing the endpoint, command or secret there updates every workflow that uses it.
- **Health you can see.** Each probe runs `initialize` and `tools/list` and records the outcome and latency. The page shows status, p50 and p95 latency, the share of failed probes and a strip of recent probes.
- **Schema history.** A snapshot of the tool list is stored on the first successful probe and whenever it changes, with a diff against the previous one.
- **A brake on breaking changes.** Optionally, runs that use the server are refused until an admin has looked at a breaking change and accepted it.

## Registering a server

Admins register servers from **MCP servers → + Register server**:

1. Optionally start from a preset (filesystem, git, GitHub and the other curated servers). The preset fills in the adapter and connection.
2. Pick the adapter: `http_mcp` for a server reachable over HTTP, `stdio_mcp` to spawn a local process, `mock-mcp` for the built-in demo tools, or a community adapter.
3. Fill in the connection JSON. For HTTP that is `endpoint`, `transport`, `timeoutMs` and `authType`. For stdio it is `command`, `args`, `env`, `cwd`, `timeoutMs` and `secretEnvVar`.
4. Pick an auth secret from the Secrets store if the server needs one. The value never goes into the connection JSON and is never returned by the API.
5. Choose the probe schedule and whether breaking changes block runs.

The server is probed once straight away unless probing is turned off for it.

## Using a registered server on a node

Open an MCP Tool node and pick it under **Registered server**. The inline adapter, connection and secret fields disappear, because the registry entry owns them. The tool list comes from the server's latest snapshot, so opening the node never starts or calls the server. Pick **None, configure on this node** to go back to inline configuration.

In workflow JSON the reference looks like this:

```json
{
  "type": "mcp_tool",
  "config": {
    "registryServerId": "mcp_6f0c…",
    "serverId": "stdio_mcp",
    "toolName": "search_issues"
  }
}
```

`registryServerId` also works inside an agent's `mcpServers` list. When it is set, the runtime takes the adapter, connection and secret from the registry and ignores inline values. If the entry has been deleted, or is blocked by an unaccepted breaking change, the node fails with a message that says so.

## Health and status

| Status | Meaning |
|---|---|
| Not probed | No probe has run yet. |
| Healthy | The latest probe succeeded, and so did the four before it. |
| Degraded | The latest probe succeeded, but at least one of the four before it failed. |
| Down | The latest probe failed. The error is shown on the server page. |

Latency percentiles and the failure rate are computed from the most recent 100 probes. Probe history is pruned to `MCP_PROBE_HISTORY_LIMIT` entries per server.

## What counts as a breaking change

The diff compares each tool's input schema with the previous snapshot, including nested objects and array items.

| Breaking | Compatible |
|---|---|
| A tool is removed | A tool is added |
| An input property is removed | An optional property is added |
| A property's type changes or narrows (for example `number` → `integer`) | A property's type widens (for example `string` → `string \| number`) |
| A new required property is added, or an optional one becomes required | A required property becomes optional |
| An enum loses a value | An enum gains a value, or its restriction is dropped |
| | A description changes |
| | A tool's annotations change |

Snapshots keep the MCP tool annotations a server sends with `tools/list` (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). A server that sends no annotations keeps the same snapshot hash as before. A change in annotations is recorded as a compatible `annotations_changed` entry and is never breaking.

A breaking snapshot becomes the server's **pending breaking change** and the page shows its diff. If **Block runs on breaking change** is on, every run that uses the server is refused until an admin presses **Accept change**. Acceptance is recorded on the snapshot and in the audit log. The block is off by default.

## Tool telemetry

Every MCP tool call made by a run is recorded when the run finishes, so the server page can show how each tool is actually used. The **Tools** table on a server's page adds these columns for the window picked above it (last 24 hours, 7 days or 30 days; 7 days by default), busiest tool first:

| Column | Meaning |
|---|---|
| Calls | Tool calls that started in the window. |
| p50, p95 | Nearest-rank latency percentiles of the successful calls, measured around the tool invocation. |
| Errors | Failed calls and their share of all calls. |
| Tokens | Input plus output tokens attributed to the calls (hover for the split). |
| Cost | Estimated cost of those tokens. |

A tool with no calls in the window shows "—". A tool that was called but is no longer in the current snapshot is still listed, marked "not in current snapshot".

### What is counted

- **Agent tool calls.** Each call an Agent or Supervisor node makes to an MCP tool, including calls made by worker agents it delegates to. Calls the runtime refuses before reaching the server (for example a missing required argument, or a tool disabled after repeated failures) count as failed calls of that tool. Calls to built-in tools such as the session cache are not MCP calls and are not counted.
- **MCP Tool nodes.** A direct MCP Tool node that ran, timed by the node. A node that failed counts as a failed call, including a node refused because its server has an unaccepted breaking change.
- MCP Tool nodes attached to an agent's `tool` port are not calls on their own; the agent's calls through them are.

Calls are attributed to a registry entry when the node or `mcpServers` entry used `registryServerId`. Calls to servers configured inline on a node have no registry entry; they are listed by adapter and tool at `GET /api/mcp/telemetry`, so they are not invisible.

### How tokens and cost are attributed

An agent turn is one model call. When a turn asks for several tool calls, its input and output tokens are split evenly across those calls (whole tokens, the remainder going to the first calls), including any non-MCP calls in the same turn. The tokens of the turn that reads the tool results and answers are not attributed to any tool.

Cost uses the same pricing table as usage and budgets (`LLM_PRICING_OVERRIDES_JSON` overrides it). When the model has no price, for example a local model, the call keeps its tokens but has no cost, and the column shows "—" if no call in the window could be priced. Direct MCP Tool nodes involve no model turn, so they carry no tokens or cost.

### Retention

Rows live in the `mcp_tool_calls` table and are pruned with execution history: calls older than `EXECUTION_HISTORY_RETENTION_DAYS` are deleted by the same job. Deleting a registry entry deletes its calls. Re-saving the same execution, for example after an approval resumes it, replaces its rows instead of adding to them.

## Tool policy

Admins can restrict which tools of a server each role may use, per project, and mark tools read-only or write. Workflows can also block every write tool. The server page's **Policies** view holds the rules, and the Tools table shows each tool's read-only classification and whether your role may use it. See [MCP tool policy](./mcp-tool-policy.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PROBE_INTERVAL_MS` | `300000` | Default probe interval. `0` turns the background loop off; **Probe now** still works. |
| `MCP_PROBE_TIMEOUT_MS` | `30000` | A probe that takes longer is recorded as failed. |
| `MCP_PROBE_HISTORY_LIMIT` | `500` | Probes kept per server. |

Servers can override the interval (at least 10 seconds) or opt out of scheduled probing. In an HA deployment only the leader instance runs scheduled probes. stdio servers start a short-lived process for each probe, which is closed when the probe ends.

## Permissions

| Action | Role |
|---|---|
| List servers, view detail and telemetry, probe now | builder and above |
| Register, edit, delete, accept a breaking change | admin |

Deleting a server that nodes still use is refused with the list of those nodes, unless the delete is forced. Register, update, delete and accept are written to the audit log as `mcp_server.*` events.

## Endpoints

- `GET /api/mcp/servers`: list servers with status and latency, plus the available adapters
- `POST /api/mcp/servers`: register a server (admin)
- `GET /api/mcp/servers/:id`: detail with recent probes, snapshots and usages
- `PUT /api/mcp/servers/:id`: update (admin)
- `DELETE /api/mcp/servers/:id?force=true`: delete (admin)
- `POST /api/mcp/servers/:id/probe`: probe now
- `GET /api/mcp/servers/:id/tools?projectId=`: tools from the current snapshot, each with its read-only classification and whether the caller's role may use it in the project
- `GET /api/mcp/servers/:id/snapshots/:snapshotId`: one snapshot with its tools and diff
- `POST /api/mcp/servers/:id/accept-change`: accept the pending breaking change (admin)
- `GET /api/mcp/servers/:id/telemetry?window=24h|7d|30d`: per-tool calls, errors, latency, tokens and cost, plus server totals
- `GET /api/mcp/telemetry?window=24h|7d|30d`: the same for servers configured inline on nodes, by adapter and tool
