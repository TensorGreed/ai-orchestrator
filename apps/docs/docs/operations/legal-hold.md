---
description: "Keep a project, workflow, set of runs or one person's data from every deletion in L2M (retention purges, deletes and data-subject deletes) until the hold is released."
---

# Legal holds

A **legal hold** keeps data from being deleted. While a hold is active, nothing it covers is deleted by any path:

- retention purges (run history, tool calls, rule events, approvals, cassettes, agent memory, usage, eval runs,
  captured runs, rule simulations, the session tool cache): held rows are left out and purged by a later purge once
  the hold is released;
- deleting a workflow, a project, a golden set, a golden-set case, a golden or captured run, or an MCP cassette: the
  request is refused with `409` and `code: "legal_hold"`, naming the holds;
- a data-subject delete (`find-subject/delete`): each held row is skipped with reason `held` and the rest go ahead.
  A hold keeps data even from an erasure request, as GDPR Art. 17(3)(e) allows for legal claims.

Holds are optional. With none placed, nothing changes. A hold never changes who may read the data; it only stops
deletion.

## Who manages holds

Admins, and users given a **deployment-wide** custom role (a custom role with no project) that grants
`legal_hold:manage`, for example a "Compliance" role. The same permission in a project's custom role grants nothing,
and only an admin can give someone a role that grants it. Placing and releasing a hold need a fresh MFA code when
[step-up](../security/auth-rbac.md#step-up-for-security-actions) is on (action `legal_hold.change`).

Admins manage holds under **Settings > Access control > Data protection > Legal holds**; other hold managers use the
API below.

## What a hold covers

| Covers | What is held |
| --- | --- |
| A project | Everything of every workflow in the project, and the project itself. |
| A workflow | Its runs and everything recorded with them, its golden runs, captured runs, golden sets and their results, its cassettes and the agent memory of its namespaces. The workflow cannot be deleted. |
| Runs | The runs you list (up to 2000 ids), with their tool calls, rule events, approvals, usage and the replay data recorded from them. Ids that do not exist are left out and counted in the audit entry. |
| A data subject | The rows the [data-subject lookup](../product/production-capture.md) finds for a value right now: runs, golden and captured runs, golden-set cases, results and cassettes. The value itself is never stored, logged or returned; the hold keeps the row ids. Rows written later are not added. |

Each hold has a name, a reason, an optional matter reference and an optional review date. The review date is a
reminder only: a hold stays until someone releases it. A release needs a reason, and a released hold stays listed
(with who released it, when and why) so the record is complete.

## Production capture under a hold

Captured runs under a hold are never evicted to make room. If a workflow's capture budget is full of held captures,
a new run is not captured (`held_budget` in `replay_captures_total{outcome}` and in the settings panel); the run
itself is unaffected. Discarding a held capture from the inbox is refused for that capture.

## Consistency

A hold is checked when data is deleted, not when it is listed, so a hold placed while a purge is running takes
effect at once. On Postgres, placing a hold waits for a purge batch or delete already under way to finish (they share
an advisory lock), and every later batch or delete sees it. On SQLite every delete runs in one process and sees the
hold immediately.

## Audit and alerts

Placing and releasing a hold are audited as `legal_hold.placed` and `legal_hold.released` (category
`data_protection`), with the scope, item count and reasons. Each also sends the `data.legal_hold_changed`
notification. Slack and Teams channels set in the environment receive it by default; a channel made in the settings
receives it once it picks the event. Alerts name the hold and its scope, never the rows.

## API

- `GET /api/legal-holds?status=active|released` (hold managers; `{ holds }`)
- `POST /api/legal-holds` (hold managers; step-up; `{ name, reason, matterRef?, endsAt?, scopeType, scopeId?, executionIds?, subject? }`; `201 { hold }`)
- `GET /api/legal-holds/status?workflowId=|projectId=|executionId=` (anyone who can read it; `{ held, holds }`, with hold names for hold managers only)
- `GET /api/legal-holds/:id`, `GET /api/legal-holds/:id/items?offset=&limit=` (hold managers)
- `POST /api/legal-holds/:id/release` (hold managers; step-up; `{ reason }`; 409 when already released)

API keys limited to projects cannot use these routes.
