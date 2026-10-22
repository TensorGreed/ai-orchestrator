# Golden runs and replay

A **golden run** is a run you keep as a reference: what went in, what every node returned and which MCP calls it made. **Replay** runs a changed workflow (the draft, or a saved version) against that reference, with every node that reaches outside L2M and every code node answered from the recording, then shows what changed and gives a verdict: **pass**, **fail** or **could not complete**. Use it to check a prompt, model or tool change before it reaches anyone.

Everything stays on your deployment.

## Saving a golden run

On the **Runs** page, **Save as golden** on a finished run opens a dialog for a name and optional notes. Builders and admins can save; the run must have finished, and a replay cannot itself be saved. Runs saved as golden runs show a **golden** badge; click it to open the latest one.

Saving copies, into separate storage:

- the workflow as it ran (captured when the run finished; for older runs, the workflow as it is saved now);
- the trigger input;
- every node's last result (for a loop, its last iteration);
- the run facts used for comparison: status, output, path, tool calls, model calls, tokens, cost and guard verdicts;
- the run's MCP cassette, if the run was recorded with **Record MCP calls**.

A golden run is not removed by execution-history retention (`EXECUTION_HISTORY_RETENTION_DAYS`), cassette pruning or saved-version pruning. It is kept until you delete it, or until its workflow is deleted.

**Record MCP calls** before you save a run whose workflow uses MCP tools. Without a cassette, a replay cannot answer MCP calls and reports that it could not complete.

### Secrets

Before anything is stored, values are scrubbed twice: credential-named keys and token-shaped strings become `[REDACTED]`, and then every secret value the deployment holds (secret store and provider keys from the environment) is replaced wherever it appears, including inside JSON strings. Workflow configurations only ever hold `secretRef.secretId`. A replay resolves credentials through the secret store like any run.

### Size

`REPLAY_RECORDING_MAX_BYTES` (default 4 MiB) caps one golden run. When a run is bigger, the largest node outputs are replaced with a `{ "_replayTruncated": true, "bytes": … }` marker until it fits, and the golden run is marked **truncated**. A replay that has to answer a node from a cut output reports **could not complete** (CLI exit code 4), because the nodes after it would see the marker instead of the data. A run that still does not fit is refused (413). `REPLAY_RECORDINGS_MAX_PER_WORKFLOW` (default 500) caps how many one workflow can have.

## What a replay does

The candidate runs on the golden run's input. Each node is classified by type:

| Node class | Examples | In a replay |
| --- | --- | --- |
| Logic | Set, If, Switch, Merge, Sort, Output, Webhook Response | Runs, including the expressions in its fields (see below) |
| Chart | Chart | Runs from inline data; a chart that needs a data URL or file is not loaded, and the replay could not complete |
| Model | LLM Call, Agent Orchestrator, Supervisor, Output Parser (it can ask the model to repair its output) | Runs live |
| Guard | Guard nodes and agent guard bindings | Runs |
| MCP | MCP Tool, agent tools | Answered from the copied cassette only |
| Code | Code node (JavaScript and Python) | Answered from the recording; never runs |
| External write | Slack, email, HTTP Request, database and queue writes, connectors that write, vector-store upserts, Execute Workflow | Answered from the recording; never runs |
| External read | Polling triggers, RAG retrieval, web browse, connector reads, PDF Output in HTML mode (Chromium loads whatever the page links to) | Answered from the recording; never runs |
| Approval, wait | Human Approval, Wait | Skipped: approvals take the recorded decision, waits pass through |
| Unknown | A node type this version does not know | Treated as an external write |

A node that has to be answered from the recording but has no recorded result (you added it after the golden run was saved) gets a stub output marked `_replayStub` and a warning in **Replay health**. It never runs live.

Code nodes are answered from the recording because neither runtime is cut off from the network: the JavaScript sandbox is a `vm` context, not an isolate, and Python runs as a subprocess. A change to a code node's script therefore does not show up in a replay; change the logic in other nodes, or save a new golden run after the change.

### What a replay does not stop yet

Expressions inside the nodes that do run are evaluated as in any run: `{{ }}` templates in prompts, Set and Output fields, If conditions and agent prompts, and Sort node expressions. These run in the API process, so an expression written to make a network call can make that call during a replay too. Treat a replay as protection against the workflow's connectors, HTTP calls and code nodes, not against a hostile workflow author. Sandboxing expressions is planned as separate work, and this page will change when it lands.

Replays never write to deployment state: session memory, the session tool cache and session artifacts live in memory for the replay and are thrown away, knowledge-base writes are refused, MCP elicitation requests are declined, the error workflow and failure notifications are not fired, and replays stay out of execution metrics and MCP tool-call telemetry. Pinned node data on the workflow is ignored. The replay itself is stored as a run with trigger type `replay`.

### MCP matching

- **Strict** (default): each recorded call answers one call with the same server, tool and scrubbed arguments.
- **Lenient**: as strict, but a call made more often than recorded reuses its last answer.

A call the cassette cannot answer fails in the replay and makes the verdict **could not complete**. Neither mode ever calls a live MCP server.

## Reading the result

The replay result shows:

- **Verdict**: pass when the status did not get worse and the output is the same; fail when the candidate's status regressed or its output changed; could not complete when the recording could not answer the candidate or the comparison would not mean anything (an unanswered MCP call, a cut recorded output, a chart that needs a data URL, an approval pause, an error before the run started).
- **Replay health**: stubbed nodes without a recording, unknown node types, unanswered MCP calls, charts that tried to load a data URL.
- **Output**: each changed path with the golden run's and the replay's value. Whitespace differences are ignored, as are timing and id fields (`**._telemetry`, `**.durationMs`, `**.latencyMs`, `**.startedAt`, `**.completedAt`, `**.executionId`).
- **Tool calls**: the two runs' tool calls side by side, aligned in order: same, arguments changed, outcome changed, new or missing.
- **Totals**: token, cost, model call and path changes.

## API

- `POST /api/replay/recordings` (builder; `{ executionId, name, notes? }`; `201 { recording }`; 409 while the run is in progress, for a replay or over the per-workflow limit; 413 over the size limit)
- `GET /api/replay/recordings?workflowId=&limit=&offset=` (viewer; `{ items, total }` for the workflows you can read)
- `GET /api/replay/recordings/:id` (viewer; input, recorded node results and run facts)
- `DELETE /api/replay/recordings/:id` (builder)
- `POST /api/replay/recordings/:id/replay` (builder; `{ draft?: true, version?: n, mcpMode?: "strict" | "lenient", ignorePaths?: string[], numberTolerance?: number }`; returns `{ recordingId, executionId, candidate, status, diff, verdict, reasons, facts }`). `ignorePaths` takes up to 32 globs of at most 128 characters each, with at most eight `**` segments per glob.

Access follows the workflow: reading needs read access, saving and deleting need edit access, replaying needs run access.

## In CI: `l2m replay run`

```bash
export L2M_API_URL=https://l2m.example.com
export L2M_API_KEY=…            # a builder API key
l2m replay run --recording rec_… --version 12 --mcp strict --ignore-path "**.id"
```

`--draft` (the default) replays the workflow as saved now; `--version <n>` replays a saved version. `--ignore-path` (repeatable) and `--number-tolerance` relax the output comparison. `--json` prints the full result. The CLI judges the diff itself and exits:

| Exit code | Meaning |
| --- | --- |
| 0 | Pass |
| 1 | The candidate differs from the golden run |
| 2 | Usage error, including flags the API rejects (HTTP 400) and ignore paths over the limits |
| 4 | The replay could not complete: the recording could not answer the candidate, the comparison would not mean anything, the request failed, or the answer was not a replay result |
