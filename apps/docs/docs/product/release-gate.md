# Release gate and publish

A workflow has a **draft** (the latest save) and, once you publish, a **published version**. Production traffic runs the published version; the editor keeps running the draft. With a **release gate** on, a version reaches production only after a replay job of that exact version passed over the workflow's [golden sets](./golden-sets.md), under the policy in force when you publish.

Nothing changes for a workflow that was never published: every entry point runs the latest save, as before.

## Which version runs where

| Started from | Runs |
| --- | --- |
| Production webhooks (`/webhook/:path`, `POST /api/webhooks/execute`, `/stream`) | the published version |
| Schedules, app triggers (Slack, GitHub, Stripe, Telegram, Discord, polling triggers) | the published version |
| Chat (`/api/chat/:workflowId`), forms, the MCP Server Trigger, the MCP gateway's workflow tools | the published version |
| `POST /api/workflows/:id/execute` and `/execute/stream` called with an API key (`Authorization: Bearer`) | the published version |
| The execution queue | the published version when the job runs |
| A sub-workflow called from any of the above | the child's published version (its draft when it was never published) |
| A retry | the version the failed run ran: a production run's published version (refused with `409` if that version was pruned), a draft run's current draft |
| The editor (**Run**, `/execute` with a signed-in session), `/webhook-test/:path`, the manual trigger, eval runs, replays | the draft, or the candidate a replay names |

Scripts and CI that call `/execute` with an API key therefore get production behaviour once the workflow is published; call `/webhook-test/` or run from the editor to exercise the draft.

A run paused on an approval resumes on the version it started with, even when another version is published meanwhile. A production webhook routes by the published version's path: a path you changed in the draft answers only on `/webhook-test/` until you publish. Schedules and app triggers re-register from the published version when you publish or roll back.

If the published version can no longer be loaded, production refuses the run instead of falling back to the draft. The same holds when a gate is on and nothing is published: the pill shows **production off**, and production answers as if the workflow had no such route until a version passes, is approved, or an admin overrides.

### Stopping production

To stop production traffic, **deactivate** the workflow (`POST /api/workflows/:id/deactivate`): every production entry point then refuses it, whatever version is published, while the editor and `/webhook-test/` keep running the draft. **Activate** brings the published version back. To change what production does instead, publish (or roll back to) another version. Turning a trigger off in the draft does not touch production until you publish it.

### Production paths are unique

A webhook path, form path or MCP Server Trigger path that a published or gated workflow answers on in production cannot be claimed by another workflow: saving, importing or duplicating a workflow that uses it answers `409` naming the workflow that owns it (or "another workflow" when you cannot read it). Webhook paths compare without case and regardless of method. Two workflows that already shared a path before this release can still be saved, but neither can be published, nor have a gate turned on, until one of them changes it. Git sync imports are not checked.

## The version pill

In the editor, the pill next to the run status shows what production runs: **v3 live**, **v3 live · draft +2** (two saved versions are newer), or **v4 · not published**. **gate** marks a workflow with a gate on, **gate · enforced** one an admin enforced. Click it to publish.

## Publishing

**Publish** picks a saved version (only saved versions publish; save first) and shows the verdict the gate gives it now:

- **No release gate**: any saved version publishes. The release is recorded as `ungated`.
- **Gate passed**: a completed replay job of this version's hash passed the policy. **Publish** binds the release to that hash and job.
- **Needs an approver**: the gate passed, but it sends every publish to an approver. **Send to approvers** creates a release request in **Approvals**.
- **Blocked**: the reasons say why (no completed job for this hash, a regression, too few cases, cost or latency above the limit, a new guard block, golden runs older than the limit, and so on). If the gate has approvers, you can **Request approval** with a reason. An admin can **Override and publish** with a reason; the reason is stored on the release and audited as `release.overridden`.

The hash is the replay job's candidate hash: a saved version under the workflow's current project. Publishing with a `workflowHash` that is not the version's hash is refused, so what ships is what was tested.

## The gate

Set it up under **Evaluations → Release gates**, or from **Set up a gate** in the Publish dialog.

- **Turning it on** publishes the version production runs now as the **baseline**, so switching a gate on never takes production down: the latest saved version (the draft is saved as a new version first when it differs from it), recorded as `ungated` with the reason "Baseline when the release gate was turned on" and audited as `release.published` with `baseline: true`. A version already published stays published.
- **Golden sets**: one or more of the workflow's sets. A job must cover all of them, and only cases from these sets count; a job that also covered other sets is judged on the gate's sets alone. A job binds to a snapshot of its sets (each case's id, golden run and scorers) taken by the server when it is queued: a job queued before a case was added, removed or rescored is no proof.
- **Policy**: minimum pass rate (default 100%), maximum regressions (default 0), minimum cases (default 3), maximum cost and p95 latency increase (no limit by default), no new guard blocks (on), errored cases count as failures (on), oldest golden run (default 30 days), required scorers.
- **MCP answers**: strict (default) or lenient. A strict gate refuses a job that replayed MCP calls leniently. A job that let any MCP write call reach a live server never passes a gate; a server whose mode is unknown counts as live writes.
- **Scorers**: the gate's candidate options name the scorers a job must have run with. Unset means the job default (`status` plus `json_equal` against the baseline). A job that ran with any other scorer list (an always-pass regex, a lone `status`) is no proof; scorers attached to individual cases in the golden set still apply.
- **Jobs that say they are not eligible**: when a replay job records `releaseEligible`, the gate requires it to be `true` and shows the job's own reasons otherwise. A job without the field is judged by the checks below.
- **Missing evidence**: a case whose stored diff is missing or truncated counts as an error when the policy has a cost, latency or guard-block limit.
- **Only plain jobs count**: guard-profile, MCP-mode, live-read and model overrides do not change a job's workflow hash, so a job that ran with any setting the gate's own candidate options do not name (an override, `models` other than `live`, `ignorePaths`, `numberTolerance`, repeats, aggregation or comparison other than the gate's, or a field this release does not know) is not proof for publishing. The reasons name the setting. The budget (`maxCostUsd`) does not count.
- **Approvers**: roles and users, and whether the requester may approve their own release (off by default). Approvers must also be allowed to publish the workflow. With **Every publish needs an approver**, a passing publish becomes a release request too.

The job is judged when you publish, under the policy then: loosening the policy lets an older job pass, and tightening it blocks a job that passed before. Every completed job for the version's hash is considered, newest first. A job completed with `compare: baseline_rerun` judges regressions against the baseline's own result, so old golden runs are not held against it; it is always accepted, whatever the gate's `compare`.

Self-approval (by the requester, or by the person who saved the version) is allowed only when an admin turned it on for that gate.

### Enforced gates

An admin can **enforce** a gate. Then only an admin can:

- turn it off, lift enforcement or loosen the policy (lower the pass rate, allow more regressions, raise or remove a limit, remove a golden set, accept older golden runs);
- change the approvers in any way, or self-approval;
- change the candidate options (scorers, MCP mode, repeats, aggregation, comparison, budget, timeout);
- remove cases from, or delete, one of its golden sets, or add a case that carries its own scorers (adding a plain case is allowed, and makes earlier jobs stale);
- roll back;
- delete the workflow.

A builder can still tighten the policy and add golden sets. A refused change answers `403` naming what it changes, and is audited (`release.gate.update_refused`, `release.golden_set_change.refused`, `release.rollback.refused`, `release.workflow_delete.refused`).

### Deleting a workflow

A workflow's gate and release history outlive it. A workflow created or imported again under the same id inherits the gate; its old releases do not make it runnable, since rollback only returns to a version whose hash matches what was released. With the gate on and nothing loadable published, production refuses runs until a new version is published through the gate. Pending release requests for a deleted workflow are canceled.

## Release requests

A release request appears in **Approvals** next to paused runs, with the version, its hash, the replay job, the gate's findings and the requester's reason. **Approve and publish** publishes exactly that version and hash; **Reject** needs a reason.

A request is refused (and canceled) when it went stale: the version's hash changed, the gate's settings changed, or another version was published after the request. It expires after the approvers' timeout (7 days by default) and is then listed as `timed_out`. Each requester gets their own request for a version: asking again returns your pending request, while a colleague asking for the same version gets a separate one; requests made stale by a gate change are canceled when anyone asks again. Approvers from a project that cannot read the workflow do not see the request; people who can read it but not publish it cannot decide it. Requests are audited as `release.approval.requested` and `release.approval.decided`.

## History and rollback

**Releases** lists every publish: version, verdict (`passed`, `approved`, `overridden`, `ungated`, `rollback`), who, when, from which version, the reason and the replay job. **Roll back** returns production to a version that was published before (with the same hash), with a reason; it skips the gate, since that version already shipped. It needs `workflow:publish`, and an admin on an enforced gate. It is audited as `release.rolled_back`.

A published or released version is pinned: version retention never prunes it. The pinned set therefore grows with every release; there is no pruning for released versions in this release, so expect it to grow until an admin-only prune is added.

## Permissions

Publishing, rollback and deciding a release request need `workflow:publish` on the workflow's project. Admins, builders, project admins and editors have it; operators and viewers do not, and a custom role can grant it. Changing the gate needs `workflow:write`. A workflow the user cannot read answers `404` on every release route, and one they can read but not change `403`. `PROJECT_ISOLATION=strict` applies as everywhere else.

## API

- `GET /api/workflows/:id/release-gate` → `{ gate }`
- `PUT /api/workflows/:id/release-gate` (`{ enabled, enforced?, datasetIds, candidateOptions? (including scorers?), policy?, requireApproval?, approvers? }`) → `{ gate }`
- `POST /api/workflows/:id/publish` (`{ version, workflowHash?, replayRunId?, override?: { reason }, requestApproval?: { reason } }`) answers `200 { release }`, `202 { verdict: "needs_approval", approvalRequestId }` or `409 { verdict: "blocked", reasons, replayRunId?, canRequestApproval }`
- `GET /api/workflows/:id/releases` → `{ releases, publishedVersion }`
- `POST /api/workflows/:id/rollback` (`{ version, reason }`) → `{ release }`
- `GET /api/workflows/:id/release-state` → `{ state: { draftVersion, publishedVersion, aheadBy, gateEnabled, gateEnforced, productionRefused, canPublish, canEditGate } }`
- `GET /api/workflows/:id/publish-preview?version=&replayRunId=` → `{ preview }`, the verdict publishing would get now

On the Postgres store every release route answers `501`, and every entry point runs the draft.
