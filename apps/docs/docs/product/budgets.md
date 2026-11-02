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

## Actions

- **Warn** never stops anything. When usage crosses the warn threshold (80% by default) or the cap, an alert is recorded, once per budget, period and level, and sent to the budget's notify webhook if it has one.
- **Block** does the same and also refuses new work once usage meets the cap, until the period ends.

## Block applies to every trigger

A used-up block budget stops a run before it starts, whatever started it:

| Trigger | What the caller gets |
|---|---|
| Run from the editor or the API (`/execute`, `/execute/stream`), retries, the webhook API, the queue API | HTTP 402 with `error: "budget_exceeded"`, the budget id, its usage, its limit, the period start and a `Retry-After` header |
| Webhooks (`/webhook/` and `/webhook-test/`), chat, forms and app webhooks | HTTP 402, as above. A webhook's idempotency key is not used up by a refused request. |
| Schedules, app and polling triggers | Nothing waits for an answer, so the run is recorded as failed: `Budget "…" exceeded for the current month. The run did not start.` |
| MCP gateway tool calls | JSON-RPC error `-32032` (see [MCP gateway](./mcp-gateway.md#budgets-and-rate-limits)) |

Runs dispatched to queue workers are checked on the instance that takes the request, before they are queued.

**Not refused:** replays and golden runs, eval runs, the resume of a run that waited on an approval, error workflows, and sub-workflows (only the run that started them is checked). Their spend still counts toward budgets.

A run that starts under the cap may take it over, and runs that start together are checked before any of them ends, so usage can pass a cap by the runs in flight. Each instance keeps a copy of the budgets and reads it again every 2 seconds and right after a change on that instance; a budget changed on another instance applies within 2 seconds. When the budgets cannot be read, runs are refused (HTTP 503) rather than started unchecked.

## API

All admin:

- `GET /api/budgets`
- `POST /api/budgets` (`{ name, scopeType, scopeId?, period, limitType, limitValue, warnThresholdPct?, action, notifyChannel? }`; `scopeType` is `global`, `project`, `workflow`, `user` or `mcp_client`, and an `mcp_client` scope names an existing client)
- `PUT /api/budgets/:id`, `DELETE /api/budgets/:id`
- `GET /api/budget-alerts?budgetId=&limit=`

A client's budgets and their usage this period: `GET /api/mcp/clients/:id/budgets` (builder).

## Related

- [MCP gateway: budgets and rate limits](./mcp-gateway.md#budgets-and-rate-limits)
- [MCP tool-call telemetry](./mcp-tool-call-telemetry.md)
