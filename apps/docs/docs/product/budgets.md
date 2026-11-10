---
description: "Budgets cap model spend or tokens per deployment, project, workflow, user or MCP client. A block budget stops new runs from every trigger and gateway calls."
---

# Budgets

A budget caps the model spend (USD) or the tokens used in a period: a day, a week (from Monday) or a month, in UTC. Admins manage budgets in **Settings**, **FinOps**, under **Budgets & alerts**. With no budget, nothing is checked.

## Scopes

| Scope | Counts |
|---|---|
| Global | Every run, and the model sampling of MCP gateway calls. |
| Project | Runs of the project's workflows, and the gateway usage of toolsets whose policy project it is. |
| Workflow | Runs of one workflow. |
| User | Runs a user started (matched on the user id or the email). |
| MCP client | One [gateway client](./mcp-gateway.md#budgets-and-rate-limits): the runs its workflow tool calls start and the model sampling its server tool calls use. Pick the client from the list. |

Usage is what the usage records hold: the tokens and the estimated cost of each run's model calls, priced with the model prices (`LLM_PRICING_OVERRIDES_JSON` adds or changes prices). A model without a known price counts its tokens, at no cost.

A model call that ends normally but whose provider reports no token usage (or only part of it) is counted with an estimate, not as zero. The estimate counts about three bytes of text a token, so it leans high, and the node's **Trace** tab marks the counts as estimated (`usageEstimated` in the node's `_telemetry`).

- Streamed runs (from the editor or `/execute/stream`) ask OpenAI and Azure OpenAI for their usage frame. If the provider refuses that option (HTTP 400 or 422 naming `stream_options`, for example an Azure resource on an older API version), the call is sent again once without it, its usage is estimated, a warning is logged, and later calls to that model leave the option out until the API restarts. Any other 400 or 422 fails the call as before. A model tape records only the second request, so the run replays. `extra.streamUsage: false` on the model never asks.
- OpenAI-compatible servers and Ollama are not asked by default, since servers differ in whether they accept the option, so their streamed usage is estimated. `extra.streamUsage: true` on the model asks for it.
- A streamed call that does not end normally is still counted once the provider has taken it: a stream that fails part way, and a call that a cancelled or timed-out run stops while the model answers, count an estimate of the prompt and of the answer streamed so far (or the provider's usage frame, if it had arrived). The node shows no tokens, since it has no output; the spend is in the run's usage and counts toward its budgets. A request the provider refuses before it starts answering (an HTTP error such as 401 or 429) costs nothing and is not counted. Calls that are not streamed and fail record no usage.
- Each model call counts once, on the node that made it. A node that passes its input on (an Approval Gate after its approval, If, Switch, Filter, No-op, a disabled node, code that returns its input, an Execute Workflow node returning its child's output) does not repeat the usage it was handed, and pinned data counts no usage.

## Actions

- **Warn** never stops anything. When usage crosses the warn threshold (80% by default) or the cap, an alert is recorded, once per budget, period and level, and sent to the budget's notify webhook if it has one.
- **Block** does the same and also refuses new work once usage meets the cap, until the period ends.

## Block applies to every trigger

A used-up block budget stops a run before it starts, whatever started it:

| Trigger | What the caller gets |
|---|---|
| Run from the editor or the API (`/execute`, `/execute/stream`), retries, the webhook API, the queue API | HTTP 402 with `error: "budget_exceeded"`, the budget id, its usage, its limit, the period start and a `Retry-After` header |
| Webhooks (`/webhook/` and `/webhook-test/`), chat, forms and app webhooks | HTTP 402, as above. A webhook's idempotency key is not used up by a refused request. |
| Schedules, app and polling triggers | Nothing waits for an answer, so a failed run is recorded: `Budget "…" exceeded for the current month. The run did not start.` |
| Replays that may call models or tools live | HTTP 402, as above (see below) |
| MCP gateway tool calls | JSON-RPC error `-32032` (see [MCP gateway](./mcp-gateway.md#budgets-and-rate-limits)) |

Runs dispatched to queue workers are checked on the instance that takes the request, before they are queued.

### Refused schedules and app triggers

Each trigger (a schedule or app trigger node of a workflow) records **one** failed run per budget and period. Later fires the same budget refuses in that period do not add runs: they count on that run (`refusedFires` and `lastRefusedAt` in its output), and only the first is logged. To keep a fast schedule or poller from writing on every fire, an instance updates that run at most once a minute, so `refusedFires` is approximate (it counts those updates, not every refused fire). Each update also moves the run's start time to the latest refusal, so it stays near the top of the history and is not pruned by retention while the budget period is current. Two instances firing the same schedule second record it once.

RSS and file triggers do not mark what a refused fire carried as seen: the same feed items or file changes fire again on a later poll, once the budget is raised or its period ends (if the feed still lists them). Events of an SSE stream arrive once; a refused one is not delivered again.

HTTP refusals (402) are logged and audited as `budget.run_refused` once per workflow, trigger type, budget and period on each instance.

### Replays

A replay is checked like a run when it may call a model or a tool live: an MCP replay of a past run (`/api/executions/:id/replay`, its model calls are live), and a golden-run replay with live models, a lenient model tape (a miss calls the live model), live-read nodes or a server answered live. A golden-run replay that answers every model and MCP call from its tapes (models from the tape, strict) is never refused; this includes release gate cases set up that way. A gate or replay job case that is refused fails with the budget's message.

**Not refused:** tape-only replays, eval runs, the resume of a run that waited on an approval, and error workflows. Their spend still counts toward budgets. A sub-workflow that a resumed run starts is checked (see [Sub-workflows](#sub-workflows)). The resumed part of a run an MCP gateway call started is charged to that client and its toolset's project, not to the approver.

A run that starts under the cap may take it over, and runs that start together are checked before any of them ends, so usage can pass a cap by the runs in flight. Each instance keeps a copy of the budgets and reads it again every 2 seconds and right after a change on that instance; a budget changed on another instance applies within 2 seconds. When the budgets cannot be read, runs are refused (HTTP 503) rather than started unchecked.

## Sub-workflows

A workflow run by an **Execute Workflow** node, or called by an agent through a **Workflow Tool**, runs inside the run that started it, so its model spend is that run's:

- It is recorded in the usage of the top-level run, and counts toward that run's workflow, project, user, MCP client and global budgets. The caller pays: a child in another project, or a child with a workflow budget of its own, does not count it toward its own budgets.
- Nested children count once, in the top-level run, however deep they are.
- A child that fails still counts what it spent before it failed. A Workflow Tool's child counts as soon as its call ends, even when the agent then fails, is stopped or waits on an approval.
- An async child (mode **async**) counts too. When it ends after its run was recorded, its spend is recorded on its own for the same run (trigger type `sub_workflow`). So is what a run's children spent before it paused for an approval, and what they spent in a run that stopped without being recorded (a queue that stopped it, a resume that failed).
- A child in another project runs with that project's credentials (secrets, model keys) but its spend counts toward the caller's budgets, not that project's. Share a workflow for **execute** only with projects whose spend on its credentials you accept.

### Refusing a child

Before a child starts, the `block` budgets of its run are checked again. A run's budgets are matched as when it started: its workflow, project and MCP client, and the user who started it, also for children started after an approval (never the approver). The check counts:

- what the run's earlier children spent,
- and a reservation for each child still running beside it: async children, and a Workflow Tool child whose call timed out. Each is reserved at the largest spend a finished child of the run has had, and at least one cent or 1,000 tokens before any has finished. Sync and Workflow Tool children run one at a time and count once they end; the children a child runs inside are not reserved against it. Children still running from before an approval pause (or from a queue attempt that was stopped) stay reserved after the run resumes.

A run's checks happen one after another, each child reserved before the next check, so children started at the same moment cannot together pass a cap. This holds within the server running the run, where all of its children run; separate runs, also on other servers, see each other only through recorded usage (see the note on runs in flight above). With no `block` budget that matches the run, nothing is checked, reserved against or limited (as long as the budgets can be read: when they cannot, a child is refused, as runs are). A check that has not finished within 15 seconds (for example a database read that hangs) refuses that child with `Sub-workflow '…' was not started: The budgets could not be read within 15 s.`, and the run's next check goes on.

A refused child does not start: the Execute Workflow node fails (an async one too) with `Sub-workflow '…' was not started: Budget "…" exceeded for the current month.`, and a Workflow Tool call returns that message to the agent as a tool error. A budget's refusal is audited as `budget.run_refused` (trigger type `sub_workflow`, with the child's workflow id) once per workflow, budget and period. A paused child that resumes after an approval is not checked again, and the children of eval runs (resumed or not) are never refused.

The run's other model calls count only when the run ends, and a reservation is an estimate, so a run can still pass a cap by its own calls or by a child that spends more than the ones before it.

### Usage views

A `sub_workflow` row is spend, not an execution: the usage totals and charts count its tokens and cost, but not as an execution or in the average duration, and the recent executions list leaves it out.

## API

All admin:

- `GET /api/budgets`
- `POST /api/budgets` (`{ name, scopeType, scopeId?, period, limitType, limitValue, warnThresholdPct?, action, notifyChannel? }`; `scopeType` is `global`, `project`, `workflow`, `user` or `mcp_client`, and an `mcp_client` scope names an existing client)
- `PUT /api/budgets/:id`, `DELETE /api/budgets/:id`
- `GET /api/budget-alerts?budgetId=&limit=`

Every budget that applies to a client (its own, its toolsets' projects', the deployment's), each with its scope label, its usage this period and whether it refuses the client's calls now: `GET /api/mcp/clients/:id/budgets` (builder).

## Related

- [MCP gateway: budgets and rate limits](./mcp-gateway.md#budgets-and-rate-limits)
- [MCP tool-call telemetry](./mcp-tool-call-telemetry.md)
