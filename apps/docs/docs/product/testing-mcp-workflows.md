# Testing MCP workflows

MCP servers change, go down and return different answers from one run to the next. L2M gives you three tools to keep workflows that depend on them testable:

- **Record and replay**: capture every MCP call a run makes as a *cassette*, then run the workflow or an eval again with the calls answered from it.
- **Snapshot mock servers**: a stub MCP server generated from a server's accepted schema snapshot, inside L2M or as a standalone stdio process.
- **`l2m mcp check`**: a CI command that fails when a server has a breaking schema change, cannot be reached, or a workflow depends on a tool that policy blocks.

Everything runs on your own deployment. Nothing is sent anywhere else.

## Record and replay

### What a cassette holds

A cassette is a JSON document (`format: "l2m.mcp-cassette"`, `version: 1`) with, in the order they happened:

- every `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list` and `prompts/get` request, and the `initialize` capabilities;
- each call's server, tool or resource name, arguments, result or error, and timing;
- the sampling and elicitation exchanges a tool call triggered, for reference.

Each server is identified by its registry id (`registry:<id>`) or, for servers configured inline on a node, by its adapter plus a short hash of its endpoint or command (`inline:http_mcp:3f2a…`). Connection details themselves are not stored. The schema snapshot hash the server had when the run started is kept next to it.

**Model calls are not recorded.** A replayed run calls your model again, so an agent can take a different path than it did when recorded. Use a deterministic model setting (temperature 0, or the `echo` provider in tests) when you need identical runs end to end.

### Secrets never reach a cassette

Before anything is written, values are scrubbed:

- the resolved value of the server's secret (and every value of a secret bundle) wherever it appears;
- credential-looking headers and environment values from the connection;
- values under credential-named keys (`token`, `password`, `apiKey`, `authorization`, …);
- token-shaped strings (bearer tokens, common API key and access token formats, JWTs);
- elicitation answers to fields that look sensitive (credential-named, or marked `password`, `writeOnly` or sensitive in the schema).

Each becomes `[REDACTED]`. OAuth tokens are never in reach of the recorder. Because arguments are scrubbed before they are matched, a replay matches the same scrubbed form.

### Recording a run

- **Editor**: open the ⋯ menu and turn on **Record MCP calls**. The Run button shows a red dot while recording is on; it stays on for the session until you turn it off.
- **Evals**: on a dataset, choose **Record MCP calls** under **MCP calls** before you start the run. Each fixture gets its own cassette.
- **API**: send `"record": true` to `POST /api/workflows/:id/execute` (or `/execute/stream`), or to `POST /api/eval/runs`.

The run result carries `mcpCassette` with the cassette's id and size. Recorded runs show a cassette badge with the call count on the **Runs** page.

Cassettes are capped by `MCP_CASSETTE_MAX_BYTES` (default 5 MiB) and `MCP_CASSETTE_MAX_CALLS` (default 5000). A run that goes past either keeps running; calls after the limit are not kept and the cassette is marked **truncated**. Cassettes are deleted with their workflow and pruned with execution history (`EXECUTION_HISTORY_RETENTION_DAYS`).

### Viewing a cassette

Click the badge on the Runs page to open the cassette: every call in order with its server, duration and an error tag when it failed. Open a call to see its arguments and result. Discovery calls (`initialize`, `tools/list`) are hidden until you tick **Show discovery calls**. **Download** saves the cassette file for `l2m mcp mock --cassette`; admins can delete it.

### Replaying a run

**Replay** on the Runs page (or in the cassette viewer) runs the execution again with the same input, answering MCP calls from its cassette, and opens the result in the editor. Through the API: `POST /api/executions/:id/replay` with `{ "mode": "strict" | "lenient", "cassetteId"? }`. The replay is a new execution with trigger type `mcp_replay`; its result carries `mcpReplay`:

```json
{ "cassetteId": "cas_…", "mode": "strict", "matched": 4, "reused": 0, "live": 0, "unmatched": [] }
```

Replay uses the workflow as it is now, so it doubles as a regression test after you edit a workflow.

**Matching.** A call matches a recorded one when the server, the method, the tool, resource or prompt name, and the hash of its canonical arguments are the same. Repeated identical calls get their answers in recorded order. Calls with different keys can come in any order, since parallel branches do not run in a fixed order. List calls (`tools/list` and friends) can be answered any number of times.

**Modes.**

| Mode | A call the cassette has no answer for |
| --- | --- |
| `strict` (default) | Fails with a message naming the server, method and tool. The run ends with status `error` and `mcpReplay.unmatched` lists every miss, even when an agent caught the failed tool call and carried on. |
| `lenient` | An identical call that ran out of recorded answers reuses the last one. A call the cassette never saw goes to the live server, and `mcpReplay.live` counts those calls. |

Strict replay never contacts an MCP server. Lenient replay is opt-in per replay.

Sampling and elicitation requests are not sent again during a replay: the tool call's recorded result already reflects them.

### Evals against cassettes

To run a dataset against what an earlier run recorded, start the eval with **Replay a recorded run** (and optionally **Live fallback**), or through the API:

```json
POST /api/eval/runs
{ "datasetId": "ds_…", "workflowId": "wf_…", "replay": { "evalRunId": "run_…", "mode": "strict" } }
```

Each fixture replays the cassette recorded for the same fixture. A fixture without one fails in strict mode. `replay.cassetteId` instead answers every fixture from one cassette. `record` and `replay` cannot be combined. `GET /api/eval/runs` shows how many cassettes each run recorded as `mcpCassettes`.

### Who can do what

| Action | Role |
| --- | --- |
| Record a run | Anyone who can run the workflow; the toggle shows for builders and admins |
| List, open and download cassettes | Builder and admin |
| Replay an execution, run evals against cassettes | Builder and admin |
| Delete a cassette | Admin (audited as `mcp_cassette.deleted`) |

## Snapshot mock servers

Every probed server has an **accepted snapshot**: the tool schemas you last accepted (a pending breaking change is not accepted until an admin accepts it). A snapshot mock serves exactly those tools, with no network access.

A mock answers `tools/call` in this order:

1. arguments are checked against the tool's input schema; invalid arguments get an `isError` result naming the problem;
2. a cassette entry with the same tool and arguments, in recorded order;
3. any recorded call of the same tool;
4. an example built from the tool's `outputSchema` (deterministic: `const`, then the first `enum` value, `default`, the first of `examples`, then a placeholder of the right type), returned as structured content;
5. a fixed text: `Mock response from '<tool>' (snapshot <hash>).`

Resources and prompts the server advertised at its last probe are listed too; reads and prompt renders come from the cassette when it has them.

### Inside L2M

Register a server with the **Snapshot mock server** adapter (`snapshot_mock`) and the connection:

```json
{ "sourceServerId": "mcp_…", "cassetteId": "cas_…", "fixedText": "…" }
```

Only `sourceServerId` (or an inline exported `snapshot`) is required. Point a copy of a workflow at the mock to demo it offline or to test it without touching the real server.

### As a stdio process

Export the snapshot, then run the mock anywhere Node.js runs:

```bash
l2m mcp snapshot export --server mcp_123 --out docs-server.snapshot.json
l2m mcp mock --snapshot docs-server.snapshot.json --cassette run.cassette.json
```

The mock speaks newline-delimited JSON-RPC on stdin and stdout (protocol versions 2025-06-18, 2025-03-26 and 2024-11-05) and writes diagnostics to stderr only, so any MCP client can start it as a stdio server.

## `l2m mcp check` in CI

The `l2m` command lives in `packages/cli`. From a checkout, run it with `pnpm l2m …`.

### Against your L2M deployment

Create an API key for a builder (Settings → API keys), then:

```bash
export L2M_API_URL=https://l2m.internal.example
export L2M_API_KEY=l2m_…
pnpm l2m mcp check                       # every registered server
pnpm l2m mcp check --server mcp_1,mcp_2  # some servers
pnpm l2m mcp check --toolset support     # a toolset's servers and the servers its workflows use
pnpm l2m mcp check --workflow wf_1 --json
```

The check calls `POST /api/mcp/check`, which:

- probes each server (`initialize` + `tools/list`) with `MCP_PROBE_TIMEOUT_MS`, without storing a probe or a snapshot;
- diffs what each server serves against its accepted snapshot with the same rules as the registry;
- evaluates tool policy for every tool a workflow names explicitly (MCP Tool nodes and agent tool allow lists), as the role that workflow's runs use.

It fails when any server has a breaking change, any server cannot be reached (`--allow-unreachable` turns that off) or any workflow depends on a blocked tool (`--allow-policy-blocked` turns that off).

### Offline, against snapshot files

Commit exported snapshots next to your workflows, then compare a server to them without an L2M deployment:

```bash
pnpm l2m mcp check --snapshot docs.snapshot.json --stdio "npx -y docs-mcp-server@1.4.0"
pnpm l2m mcp check --snapshot docs.snapshot.json --url https://mcp.internal.example/mcp
pnpm l2m mcp check --snapshot docs.snapshot.json --against docs.next.snapshot.json
```

Offline checks cover breaking changes and reachability; tool policy needs the API.

### Exit codes and output

| Exit code | Meaning |
| --- | --- |
| 0 | Clean. Additive changes are listed but do not fail the check. |
| 1 | A check failed, or the API refused the request or could not be reached. |
| 2 | Usage error: unknown command, missing flag or unreadable file. |

`--json` prints the full report (`ok`, `servers[]` with hashes, changes and latency, `blockedTools[]`, `failures[]`) instead of the human summary.

A CI job only needs the two variables from your CI secret store and the exit code:

```bash
# L2M_API_URL and L2M_API_KEY come from the CI secret store.
pnpm install --frozen-lockfile
pnpm l2m mcp check --json > mcp-check.json   # the job fails when this exits non-zero
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_CASSETTE_MAX_BYTES` | `5242880` | Largest cassette kept, in bytes (1 KiB to 256 MiB). |
| `MCP_CASSETTE_MAX_CALLS` | `5000` | Most calls kept in one cassette (1 to 100000). |
| `MCP_PROBE_TIMEOUT_MS` | `30000` | Per-server timeout of `POST /api/mcp/check` (shared with health probes). |

See the [endpoint reference](../api/endpoints.md#mcp-testing) for every route.
