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
- A call that does not end normally records no usage: a stream that fails part way, a run that is cancelled, and a run that times out are not counted, even for the tokens the provider already produced.

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

**Not refused:** tape-only replays, eval runs, the resume of a run that waited on an approval, error workflows, and sub-workflows (only the run that started them is checked). Their spend still counts toward budgets. The resumed part of a run an MCP gateway call started is charged to that client and its toolset's project, not to the approver.

A run that starts under the cap may take it over, and runs that start together are checked before any of them ends, so usage can pass a cap by the runs in flight. Each instance keeps a copy of the budgets and reads it again every 2 seconds and right after a change on that instance; a budget changed on another instance applies within 2 seconds. When the budgets cannot be read, runs are refused (HTTP 503) rather than started unchecked.

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
