---
description: "Save known-good runs as golden runs and replay a changed L2M workflow against them, with external calls answered from the recording, to get a pass or fail verdict."
---

# Golden runs and replay

A **golden run** is a run you keep as a reference: what went in, what every node returned and which MCP calls it made. **Replay** runs a changed workflow (the draft, or a saved version) against that reference, with every node that reaches outside L2M and every code node answered from the recording, then shows what changed and gives a verdict: **pass**, **fail** or **inconclusive**. Use it to check a prompt, model or tool change before it reaches anyone.

Everything stays on your deployment.

## Saving a golden run

On the **Runs** page, **Save as golden** on a finished run opens a dialog for a name and optional notes. Builders and admins can save; the run must have finished, and a replay cannot itself be saved. Runs saved as golden runs show a **golden** badge; click it to open the latest one.

Saving copies, into separate storage:

- the workflow as it ran (captured when the run finished; for older runs, the workflow as it is saved now);
- the trigger input;
- every node's result (for a node in a loop, the result of each iteration, in order);
- the run facts used for comparison: status, output, path, tool calls, model calls, tokens, cost and guard verdicts;
- the run's MCP cassette, if the run was recorded with **Record MCP calls**;
- with that cassette, the run's **model tape** (every model call it made, and its answer) and **memory seed** (what session memory held for each session the run read, before the run changed it).

A golden run is not removed by execution-history retention (`EXECUTION_HISTORY_RETENTION_DAYS`), cassette pruning or saved-version pruning. It is kept until you delete it, or until its workflow is deleted.

**Record MCP calls** before you save a run whose workflow uses MCP tools. Without a cassette, a replay cannot answer MCP calls and is inconclusive.

### Model tape and memory seed

Recording a run records its model calls too. Each entry is keyed by the node that made the call, the agent loop iteration, the provider, the model and the SHA-256 of the canonical, scrubbed request (messages, tools and sampling settings; never the endpoint or the credential). The answer is scrubbed like a cassette entry: the provider's own key, every deployment secret and credential-shaped strings are replaced before anything is stored. A streamed call is stored as its complete answer.

The tape is stored inside the cassette row, so it gets the cassette's limits (`MCP_CASSETTE_MAX_BYTES` and `MCP_CASSETTE_MAX_CALLS`, applied to the tape on its own; a tape that hits them is marked truncated and stops recording) and is deleted with it (cassettes are pruned with execution history, `EXECUTION_HISTORY_RETENTION_DAYS`). The memory seed is capped at `MCP_CASSETTE_MAX_BYTES` too. Saving the run as a golden run copies both, scrubbed again, and they count toward the golden run's size limit (`REPLAY_RECORDING_MAX_BYTES`) with the node outputs: when they do not fit, the tape keeps its first calls and is marked `truncated`, then the seed keeps the sessions that fit and is marked `truncated`, and the golden run is marked truncated. A model replay that reaches a call cut from the tape is inconclusive, and its reason says the tape was cut. A golden run's detail shows how many model calls its tape holds (`modelCallCount`) and its capabilities say `models: "tape"` and `memory: "seeded"` when it has them.

A [replay job](./golden-sets.md#candidates-and-comparison) with model calls **from the tape** answers each model call from it instead of calling the model, and starts session memory from the seed. A golden run saved from a run recorded before this release, or without **Record MCP calls**, has no tape: under model calls from the tape its cases are inconclusive straight away, and nothing runs.

### Secrets

Before anything is stored, values are scrubbed twice: credential-named keys and token-shaped strings become `[REDACTED]`, and then every secret value the deployment holds (secret store and provider keys from the environment) is replaced wherever it appears, including inside JSON strings. Workflow configurations only ever hold `secretRef.secretId`. A replay resolves credentials through the secret store like any run.

Scrubbing can change values that later nodes read: a pagination field named `token`, or any string of 40 or more letters, digits and `+/=_-` (a SHA-256, a long document id), becomes `[REDACTED]`. The golden run remembers where that happened. When a replay feeds such a value to the candidate, **Replay health** shows a `scrubbed recording` warning for that node (and for the input or output), so a fail caused by a placeholder is easy to spot. The warning does not change the verdict.

### Size

`REPLAY_RECORDING_MAX_BYTES` (default 4 MiB) caps one golden run. When a run is bigger, the largest node outputs are replaced with a `{ "_replayTruncated": true, "bytes": … }` marker until it fits, and the golden run is marked **truncated**. A replay that has to answer a node from a cut output reports **inconclusive** (CLI exit code 4), because the nodes after it would see the marker instead of the data. The MCP cassette counts toward the cap together with the model tape and the memory seed. The cassette cannot be cut, so the node outputs give way to it, and a run whose workflow, facts and cassette alone do not fit is refused (413). `REPLAY_RECORDINGS_MAX_PER_WORKFLOW` (default 500) caps how many one workflow can have, `REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW` (default 256 MiB) caps the bytes they use together, copied cassettes included, and `REPLAY_RECORDINGS_MAX_TOTAL_BYTES` (default 1 GiB) caps the bytes of every golden run in the deployment. Golden runs are never pruned automatically, so saving past any of these limits is refused (409) until you delete some. Sizes are first estimated from the raw run, so a run far over a limit is refused before the scrubbing work starts.

A run can be saved once. Saving the same run again is refused (409) with the id of the golden run it was saved as; the Runs page shows **Save as golden** only on runs that have not been saved.

## What a replay does

The candidate runs on the golden run's input. Each node is classified by type:

| Node class | Examples | In a replay |
| --- | --- | --- |
| Logic | Set, If, Switch, Merge, Sort, Output, Webhook Response | Runs, including the expressions in its fields (sandboxed; see below) |
| Chart | Chart | Runs from inline data; a chart that needs a data URL or file is not loaded, and the replay is inconclusive |
| Model | LLM Call, Agent Orchestrator, Supervisor, Output Parser (it can ask the model to repair its output) | Runs live; in a replay job with model calls from the tape, answered from the golden run's model tape |
| Guard | Guard nodes and agent guard bindings | Runs |
| MCP | MCP Tool, agent tools | Answered from the copied cassette only |
| Code | Code node (JavaScript and Python) | Answered from the recording; never runs |
| External write | Slack, email, HTTP Request, database and queue writes, connectors that write, vector-store upserts, Execute Workflow | Answered from the recording; never runs |
| External read | Polling triggers, RAG retrieval, web browse, connector reads, PDF Output in HTML mode (Chromium loads whatever the page links to) | Answered from the recording; a replay job can list read nodes to run live instead |
| Approval, wait | Human Approval, Wait | Skipped: approvals take the recorded decision, waits pass through |
| Unknown | A node type this version does not know | Treated as an external write |

A node that has to be answered from the recording but has no recorded result (you added it after the golden run was saved, or a changed branch now reaches it) gets a stub output marked `_replayStub`. It never runs live, and the replay reports **inconclusive** (CLI exit code 4): whatever the output says, that node was never tested. Save a golden run that goes through it.

A node answered from the recording inside a loop gets the recorded result of the same iteration. If the candidate calls it more often than the golden run did, the extra calls cannot be judged and the replay is **inconclusive**, for every node that is answered from the recording.

Code nodes are answered from the recording because neither runtime is cut off from the network: the JavaScript sandbox is a `vm` context, not an isolate, and Python runs as a subprocess. A replay therefore cannot test a change to a code node: when a code node's code or settings differ from the golden run's, the replay reports **inconclusive** and names the node ("code changed since the golden run; code nodes are not executed in replay"). Save a new golden run after the change. A changed external read or write is answered from the recording too, with a warning that the change is untested.

### What a replay does not stop yet

Expressions inside the nodes that do run are evaluated as in any run: `{{ }}` templates in prompts, Set and Output fields, If conditions and agent prompts, and Sort node expressions. These run in an isolated realm with no host access — no `process`, `require`, `fetch`, timers or file system, and a time limit — so an expression cannot reach the network or disk, in a replay or anywhere else. See [Code nodes and expressions](/security/code-execution) for how that sandbox works.

Replays never write to deployment state: session memory (which starts from the golden run's memory seed when it has one, else empty), the session tool cache and session artifacts live in memory for the replay and are thrown away, knowledge-base writes are refused, MCP elicitation requests are declined, the error workflow and failure notifications are not fired, budget alerts are not sent (a replay's live model spend still counts toward budgets, so the next real run over a threshold sends the alert), and replays stay out of execution metrics and MCP tool-call telemetry. Pinned node data on the workflow is ignored. The replay itself is stored as a run with trigger type `replay`.

### MCP matching

- **Strict** (default): each recorded call answers one call with the same server, tool and scrubbed arguments.
- **Lenient**: as strict, but a call made more often than recorded reuses its last answer.

A call the cassette cannot answer fails in the replay and makes the verdict **inconclusive**. Neither mode ever calls a live MCP server.

## Reading the result

The replay result shows:

- **Verdict**: pass when the status did not get worse and the output is the same; fail when the candidate's status regressed or its output changed; inconclusive when the recording could not answer the candidate or the comparison would not mean anything (an unanswered MCP call, a node the golden run never saw, a code, read or write node that ran more often than recorded, or a code node whose code changed, a cut recorded output, a chart that needs a data URL, an approval pause, an error before the run started).
- **Replay health**: stubbed nodes without a recording, recorded nodes whose configuration changed, recorded nodes called more often than recorded, unknown node types, unanswered MCP calls, charts that tried to load a data URL, cut recorded outputs, recorded values changed by scrubbing, and an output diff with more changes than it lists.
- **Output**: each changed path with the golden run's and the replay's value. Whitespace differences are ignored, as are timing and id fields (`**._telemetry`, `**.durationMs`, `**.latencyMs`, `**.startedAt`, `**.completedAt`, `**.executionId`).
- **Tool calls**: the two runs' tool calls side by side, aligned in order: same, arguments changed, outcome changed, new or missing.
- **Totals**: token, cost, model call and path changes.

### Guard-masked text

When masking is expected in a comparison, two texts that differ only in what a guard mask hid compare as equal. That is the case when the golden run is a masked [production capture](./production-capture.md) made on this server, or when the guard masked, redacted or protected content in either run (a shadow-only verdict does not count). A golden run imported from a file never turns it on: a masked flag or guard verdicts in the file are not this server's word, so its own text is compared exactly (the live run's verdicts still count). In every other comparison, strings are compared as they are, with only whitespace differences ignored.

Only the exact shapes the guard `mask` action writes count as masks, and only as whole words:

| Class | Mask | Compares equal to |
| --- | --- | --- |
| Email | `j•••@e••••••.com` | any other masked email, such as `u•••••••••••••@s••••••••.invalid` |
| Card | `•••• •••• •••• 1111`, `••••••••••••1111` | any other masked card |
| SSN, NI number | `•••-••-6789`, `•• •• •• 56 C` | any other masked SSN or NI number |
| Phone | `•• •••-•••-••23` | any other masked phone |
| IBAN | `GB•• •••• •••• •••• •••4 32` | any other masked IBAN |
| Fully masked value | `••••••••` (three or more) | any other fully masked value |

Redaction placeholders compare without regard to case (`[REDACTED:Email]` and `[redacted:email]`), but a different class still counts as a change. Anything else still counts:

- a lone `•` or `••`, such as a bullet in a list: `• 3 tablets` and `• 30 tablets` differ
- mask characters glued to a word: `•OK` and `•FAIL` differ, and so do `ssn:•••1111` and `id:•••1111` (the key before the mask is compared)
- a number after a single masked group: `•••• 12 items` and `•••• 13 items` differ (a kept tail after a space or dash belongs to the mask only after two or more masked groups, as in a spaced card)
- the known cost of that rule: a number right after two or more masked groups is read as part of the mask, so `•••• •••• 12 items` and `•••• •••• 13 items` compare equal. An NI number's suffix letter counts only in upper case (`56 C`)
- a NUL character already in the text is never read as a mask
- masked text against unmasked text: `••••••••••••1111` never equals `4111111111111111`

## API

- `POST /api/replay/recordings` (builder; `{ executionId, name, notes? }`; `201 { recording }`; 409 while the run is in progress, for a replay, for a run already saved, or over the per-workflow count or byte limit; 413 over the size limit)
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
| 4 | The replay is inconclusive: the recording could not answer the candidate, the comparison would not mean anything, the request failed, or the answer was not a replay result |

To replay many golden runs at once, score them and gate CI on the whole suite, see [Golden sets, replay jobs and scorers](./golden-sets.md).
