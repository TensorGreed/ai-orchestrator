---
title: "Legal holds: keep data from deletion and purges"
description: "Keep a project, workflow, set of runs or one person's data in L2M from retention purges, deletes and data-subject deletes until the hold is released."
---

# Legal holds

A **legal hold** keeps data from being deleted. Holds are optional: with none placed, nothing changes. A hold never
changes who may read the data; it only stops deletion.

Concepts: [AI data retention, erasure requests and legal holds](/learn/operations/ai-data-retention-and-erasure).

While a hold is active, the data it covers is kept from:

- **Retention purges**, with the deployment's values and with a project's own. Run history, tool calls, rule events, approvals, cassettes, agent memory, usage, gateway
  requests, queue rows, eval runs, captured runs, rule simulations and the session tool cache all leave held rows out.
  They are purged by the first purge after the hold is released. The gateway's own sweep of decided approvals keeps
  held ones too.
- **Deletes.** Deleting a workflow, a project, a golden set, a golden-set case, a golden or captured run, or an MCP
  cassette is refused with `409` and `code: "legal_hold"`, naming the holds. So is removing a held case at a
  [release gate](../product/release-gate.md) (rejecting it, or approving a removal request).
- **Moves.** A workflow under a hold, or in a held project, cannot be moved to another project (by a transfer or a
  save with a new project): `409 legal_hold`. Its runs reach their project through the workflow, so a move would
  take them out of the hold.
- **Side effects of other deletes.** Deleting an MCP server keeps the held tool calls it made. Workflow versions are
  not pruned while a hold covers the workflow.
- **Agent memory trimming.** An agent saves only its last messages. While a hold covers a session's memory, the
  stored history only grows: new messages are added after the old ones, and nothing is dropped. The agent still reads
  only its last messages, as before.
- **Data-subject deletes** (`find-subject/delete`). Each held row is skipped with reason `held`; the rest go ahead. A
  hold keeps data even from an erasure request, as GDPR Art. 17(3)(e) allows for legal claims.
- **Data-subject deletion requests.** Held rows are deferred (the request shows **Partly deleted: waiting for a legal
  hold**) and a staff member's email stays in held rows; releasing the hold runs the deletion again for them. See
  [Deleting a person's data](../security/data-subject-requests.md#deleting-a-persons-data).

What a hold does **not** keep:

- **Session artifacts.** An agent's artifact is replaced when the agent writes a new value under the same key. The
  artifact itself is never deleted while held, but its earlier values are not kept.
- **The audit log, signed run manifests and configuration** (MCP servers, rules, secrets, users) follow their own
  rules. A held run keeps its manifest.
- **A restore.** `db:import --replace` is refused while the destination has active holds, unless you pass
  `--allow-replace-held` (see [Backup and recovery](./backup-and-recovery.md)). `db:copy` only copies into an empty
  database. When you place a hold, take a backup too: a hold cannot protect data from someone with database access.

## Who manages holds

Admins, and users given a **deployment-wide** custom role (a custom role with no project) that grants
`legal_hold:manage`, for example a "Compliance" role. The same permission in a project's custom role grants nothing.
Only an admin can give someone a role that grants it, and only an admin can remove or change that person's
membership.

- **Data-subject holds are admin-only**, because placing one runs the admin-only data-subject lookup: whether it
  finds anything says whether a value is stored.
- Placing and releasing a hold need a fresh MFA code when
  [step-up](../security/auth-rbac.md#step-up-for-security-actions) is on (action `legal_hold.change`).
- **A release needs a signed-in person**: API keys are refused.

Admins manage holds under **Settings > Access control > Data protection > Legal holds**; other hold managers use the
API below.

## What a hold covers

| Covers | What is held |
| --- | --- |
| A project | Everything of every workflow in the project, and the project itself. |
| A workflow | Its runs and everything recorded with them, its golden runs, captured runs, golden sets and their results, its cassettes, its versions and the agent memory of its namespaces. The workflow cannot be deleted or moved. |
| Runs | The runs you list (up to 2000 ids), with their tool calls, rule events, approvals, usage and the replay data recorded from them. Ids that do not exist are left out and counted in the audit entry. |
| A data subject | The rows the [data-subject lookup](../product/production-capture.md) finds for a value right now: runs, golden and captured runs, golden-set cases, results and cassettes. The value itself is never stored, logged or returned; the hold keeps the row ids. Rows written later are not added. |

Each hold has a name, a reason, an optional matter reference and an optional review date. The review date is shown
next to the hold for your own follow-up; no reminder or notification is sent, and the hold does not end on that date.
A hold stays until someone releases it. A release needs a reason, and a released hold stays listed (with who released
it, when and why) so the record is complete.

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
notification, but only to channels made in the settings that pick it: a hold's name can name a matter, so the Slack
and Teams channels set in the environment do not receive it. Alerts name the hold and its scope, never the rows.

## API

- `GET /api/legal-holds?status=active|released` (hold managers; `{ holds }`)
- `POST /api/legal-holds` (hold managers, `subject` scope admins only; step-up; `{ name, reason, matterRef?, endsAt?, scopeType, scopeId?, executionIds?, subject? }`; `201 { hold }`)
- `GET /api/legal-holds/status?workflowId=|projectId=|executionId=` (anyone who can read it; `{ held, holds }`, with hold names for hold managers only)
- `GET /api/legal-holds/:id`, `GET /api/legal-holds/:id/items?offset=&limit=` (hold managers)
- `POST /api/legal-holds/:id/release` (hold managers, signed-in only; step-up; `{ reason }`; 409 when already released)

API keys limited to projects cannot use these routes.

Background: [Retention, legal holds and data-subject requests](../blog/retention-legal-holds-and-subject-requests) (blog).
