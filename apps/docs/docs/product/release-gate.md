# Release gate and publish

A workflow has a **draft** (the latest save) and, once you publish, a **published version**. Production traffic runs the published version; the editor keeps running the draft. With a **release gate** on, a version reaches production only after a replay job of that exact version passed over the workflow's [golden sets](./golden-sets.md), under the policy in force when you publish.

Nothing changes for a workflow that was never published: every entry point runs the latest save, as before.

## Which version runs where

| Started from | Runs |
| --- | --- |
| Production webhooks (`/webhook/:path`, `POST /api/webhooks/execute`, `/stream`) | the published version |
| Schedules, app triggers (Slack, GitHub, Stripe, Telegram, Discord, polling triggers) | the published version |
| Chat (`/api/chat/:workflowId`), forms, the MCP Server Trigger, the MCP gateway's workflow tools | the published version |
| `POST /api/workflows/:id/execute` and `/execute/stream` called with an API key (`Authorization: Bearer`) | the published version; the draft with `?channel=draft` when the key's user has `workflow:write` on the workflow |
| The execution queue | the published version when the job runs |
| A sub-workflow called from any of the above | the child's published version (its draft when it was never published) |
| A retry | the failed run's channel: a production run is retried as production runs now (the version published today, never a superseded or rolled-back one), a draft run on the current draft. A run whose channel was not recorded (history from before releases, or a record that failed to save) is retried as production on a gated workflow, never on the draft |
| The editor (**Run**, `/execute` with a signed-in session), `/webhook-test/:path`, the manual trigger, eval runs, replays | the draft, or the candidate a replay names |

Scripts and CI that call `/execute` with an API key therefore get production behaviour once the workflow is published. To test a change you just saved, add `?channel=draft` (needs `workflow:write`), call `/webhook-test/`, or run from the editor.

A run paused on an approval resumes on the version it started with, even when another version is published meanwhile. A production webhook routes by the published version's path: a path you changed in the draft answers only on `/webhook-test/` until you publish. Schedules and app triggers re-register from the published version when you publish or roll back.

If the published version can no longer be loaded, production refuses the run instead of falling back to the draft. The same holds when a gate is on and nothing is published: the pill shows **production off**, and production refuses runs (`409`, "No published version of this workflow can be loaded") until a version passes, is approved, or an admin overrides.

### Deactivating a workflow

What **deactivate** (`POST /api/workflows/:id/deactivate`) does depends on the gate:

- **Without a release gate** it works as it always did: it unregisters the workflow's schedules and app or polling triggers. Production webhooks, chat, forms, the MCP Server Trigger, the MCP gateway, API-key `/execute`, queued jobs and sub-workflow calls keep running, whether or not a version is published.
- **With a release gate on** it is the kill switch: every production entry point refuses the workflow, whatever version is published. Webhooks, forms, the MCP Server Trigger, chat, app webhooks and API-key `/execute` answer `409` with "This workflow is deactivated, so production runs are refused." Queued jobs fail with that message, a production run that calls it as a sub-workflow fails with it, a production failure that names it as the error workflow skips it (the log says why), and the MCP gateway stops listing its tool. The editor and `/webhook-test/` keep running the draft. **Activate** brings the published version back.

To change what production does instead, publish (or roll back to) another version, or [unpublish](#unpublish) to run the draft. Turning a trigger off in the draft does not touch production until you publish it.

### Production paths belong to what serves production

A webhook path, form path or MCP Server Trigger path is claimed by what actually serves production on it:

- a gated workflow claims the paths of its **published version**; its draft claims nothing, so you can move a gated workflow's draft to any path and save it (after an [unpublish](#unpublish) the draft serves production, so it claims its paths);
- a workflow without a gate, active or deactivated, claims the paths of its published version when it has one, otherwise those of its saved workflow. Deactivating an ungated workflow only unregisters its schedules and triggers, so its webhooks, forms and MCP triggers keep serving production and keep their paths.

A save (create, update, import, external import, restore, move, activate) is refused with `409` only when it would put an ungated workflow on a path another workflow claims. The message names that workflow when you can read it, and says "another workflow" otherwise. A path a workflow already claimed before the save never blocks it, so two workflows that shared a path before this release can both still be saved. Publishing, turning a gate on (its baseline), rollback and approving a release are refused while the version's paths are claimed by another workflow; an admin override does not skip this. Webhook paths compare without case and regardless of method, form and MCP trigger paths without case.

**Duplicate**, **use a template** and **import a shared link** never answer `409` for a path: each trigger path another workflow already uses gets `-copy`, then `-copy-2`, `-copy-3` and so on. New webhook, form and MCP trigger nodes added in the editor get a default path with a short random suffix; saved workflows keep their paths.

**Git pull** refuses only a workflow that would take a claimed path. The result lists it under `workflowsRefused` with the reason, and Settings shows it. The other workflows import.

## The version pill

In the editor, the pill next to the run status shows what production runs: **v3 live**, **v3 live · draft +2** (two saved versions are newer), **v4 · not published**, or **v4 · unpublished** (the published version was [taken down](#unpublish) and production runs the draft). **gate** marks a workflow with a gate on, **gate · enforced** one an admin enforced. Click it to publish.

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
- **Golden sets**: one or more of the workflow's sets. A job must cover all of them, and only cases from these sets count; a job that also covered other sets is judged on the gate's sets alone. A job binds to a snapshot of its sets (each case's id, golden run and scorers) taken by the server when it is queued: a job queued before a case was added, removed or rescored is no proof, and neither is a job queued before release gates existed (run the gate again). An enforced gate counts only its admitted cases, so it judges this over them alone: a job is stale when an admitted case is missing from it or its golden run or scorers changed, and cases waiting for admission, added or deleted later, change nothing (see [Case admission](#case-admission-and-required-cases)).
- **Policy**: minimum pass rate (default 100%), maximum regressions (default 0), minimum cases (default 3), maximum cost and p95 latency increase (no limit by default), no new guard blocks (on), errored cases count as failures (on), oldest golden run (default 30 days), required scorers.
- **MCP answers**: strict (default) or lenient. A strict gate refuses a job that replayed MCP calls leniently. A job that replayed leniently is never eligible to prove a release, so a lenient gate is still satisfied only by strict jobs; keep it strict unless you have a reason. A job that let any MCP write call reach a live server never passes a gate; a server whose mode is unknown counts as live writes.
- **Repeats**: when a job repeats its cases, the gate judges each case at its worst repeat, so one slow repeat or one repeat that adds a block is enough to block the release. Against the recording (the default `compare`), that is the highest cost, the highest latency and the most new guard blocks of any repeat, all measured against the one recording. With `compare: "baseline_rerun"` every repeat reruns its own baseline, so each repeat's cost and latency are compared with its own baseline rerun and the case counts at the repeat that rose most over its own baseline: a slowdown that hits a repeat's baseline and candidate alike cancels out. With one recorded baseline, more repeats make a latency limit stricter (the slowest of five live runs is slower than a typical one), so leave headroom for model jitter or compare with baseline reruns. A repeat whose baseline rerun was inconclusive never ran the candidate and has no cost, latency or guard figures, so it is left out of them: under `aggregate: "all"` the case is inconclusive anyway; under `majority` or `any` it is judged on the repeats that ran. A job that ran with repeats above 1 before replays recorded these figures for every repeat has them for one repeat only, so a gate with a latency or guard limit (`noNewGuardBlocks` is on by default) refuses it, and a pending release request that names it is canceled when it is approved: run the gate again (the new job records every repeat), or remove those limits.
- **Scorers**: the gate's candidate options name the scorers a job must have run with. Unset means the job default (`status` plus `json_equal` against the baseline). A job that ran with any other scorer list (an always-pass regex, a lone `status`) is no proof; scorers attached to individual cases in the golden set still apply.
- **Jobs that say they are not eligible**: when a replay job records `releaseEligible`, the gate requires it to be `true` and shows the job's own reasons otherwise. A job without the field is judged by the checks below.
- **Missing evidence**: a case whose stored diff is missing or truncated counts as an error when the policy has a cost, latency or guard-block limit.
- **Only plain jobs count**: guard-profile, MCP-mode, live-read and model overrides do not change a job's workflow hash, so a job that ran with any setting the gate's own candidate options do not name (an override, `models` other than `live`, `ignorePaths`, `numberTolerance`, repeats, aggregation or comparison other than the gate's, or a field this release does not know) is not proof for publishing. The reasons name the setting. The budget (`maxCostUsd`) does not count.
- **Approvers**: roles and users, and whether the requester may approve their own release (off by default). With no roles or users named, **anyone else who may publish this workflow** approves. Approvers must also be allowed to publish the workflow. With **Every publish needs an approver**, a passing publish becomes a release request too.

The job is judged when you publish, under the policy then: loosening the policy lets an older job pass, and tightening it blocks a job that passed before. Every completed job for the version's hash is considered, newest first. A job completed with `compare: baseline_rerun` judges regressions against the baseline's own result, so old golden runs are not held against it; it is always accepted, whatever the gate's `compare`.

Self-approval (by the requester, or by the person who saved the version) is allowed only when an admin turned it on for that gate.

### Enforced gates

An admin can **enforce** a gate. Then only an admin can:

- turn it off, lift enforcement or loosen the policy (lower the pass rate, allow more regressions, raise or remove a limit, remove a golden set, accept older golden runs);
- change the approvers in any way, or self-approval;
- change the candidate options (scorers, MCP mode, repeats, aggregation, comparison, budget, timeout);
- remove an admitted case from one of its golden sets, delete one of its golden sets, add a case that carries its own scorers, or delete a golden run an admitted case uses (adding a plain case is allowed, and the new case waits for admission without making earlier jobs stale: see [Case admission](#case-admission-and-required-cases));
- admit cases, reject waiting ones, and mark cases required or stop requiring them;
- roll back;
- unpublish (while the gate is also switched on);
- delete the workflow.

A builder can still tighten the policy and add golden sets. A refused change answers `403` naming what it changes, and is audited (`release.gate.update_refused`, `release.golden_set_change.refused`, `release.rollback.refused`, `release.workflow_delete.refused`, `release.unpublish.refused`).

### Case admission and required cases

On an enforced gate, a builder could otherwise make a failing version pass by adding easy cases (18 of 20 passing is 90%; add 40 cases that always pass and it is 58 of 60, 96.7%) or by deleting the failing ones. Enforced gates therefore count only **admitted** cases.

- When an admin enforces a gate for the first time, every case its golden sets hold is admitted. Nothing is admitted silently after that. When an admin adds a golden set to an enforced gate, the gate card asks "Admit N cases from the added set?"; only when they tick it are that set's cases admitted with the save (the API takes `admitAddedSetCases: true`, admins only). Otherwise the set's cases wait for admission like any other.
- A case added afterwards, by any path (a golden run added in Evaluations or through the API, a hand-written case, a golden-set file import whose set a builder adds to the gate, a promoted capture), is **pending admission**. It runs with every gate job and shows in the results, but it counts toward nothing: not the pass rate, not the minimum number of cases, not regressions, cost, latency or guard blocks. A golden set a builder adds to an enforced gate starts with all its cases pending.
- An admin admits pending cases, or rejects them (the case leaves its golden set; the golden run is kept), from the gate's **Cases this gate counts** card. A builder clicks **Request admission** instead: the request goes to the gate's approvers in **Approvals** (the gate's admins when it names no approvers), with a reason. Approving admits the cases that are still pending.
- A builder cannot remove an admitted case, or delete a golden set the gate uses: the API answers `403` with a plain message. A pending case is not counted (a required mark on it has no effect either), so a builder may remove it. To remove an admitted case a builder clicks **Request removal**; approving it removes the case from its set (the golden run is kept). Admins remove cases directly.
- An admin can mark a golden-run case **required** (which admits it if it was pending). A required case must pass on every publish: if it fails, is inconclusive, is skipped or does not run, the publish is blocked whatever the pass rate, and the reason names the case (`Required case "Refund over limit" was inconclusive`). This holds even when the gate does not count errors as failures, because a candidate can make a case inconclusive on its own (a new MCP call missing from the cassette, a model-tape miss). Only an admitted case counts as required. Hand-written cases cannot be required, since replay jobs skip them. Only admins set or clear required, and on an enforced gate the golden set page shows a **required** chip on such cases.
- The gate card shows a plain banner while cases wait, for example "3 new cases waiting for admin admission. They run but don't count yet." The publish dialog lists how many cases are pending and required.

Admission requests follow the release-request rules: approvers must be able to read and publish the workflow (so they are project-scoped), the requester cannot approve their own request unless the gate allows self-approval, and a request expires after the approvers' timeout. A request is decided against the gate as it is when someone decides, never as it was when it was asked: the approver must be one of the gate's approvers now, and self-approval must be allowed now. A later change to who decides (the gate's approvers, self-approval or enforcement, which only an admin can make on an enforced gate) makes open requests **stale**, and so does the gate no longer being enforced or none of the request's cases still fitting (already admitted, or no longer there). Other saves of the gate, such as a builder tightening the policy or saving it unchanged, leave open requests as they are; a save that changes nothing does not even move the gate's last-updated time. A stale request cannot be approved: the inbox says why ("Who decides the release gate's cases (its approvers, self-approval or enforcement) changed after the request was made"), approving it answers `409` and cancels it, and the builder asks again.

Every admission change is audited, whoever makes it:

| What | Audit event |
| --- | --- |
| An admin admits cases, or an approved request admits them | `release.gate.cases_admitted` |
| An admin rejects pending cases | `release.gate.cases_rejected` |
| An admin marks a case required or stops requiring it | `release.gate.case_required` |
| An approved removal request; an admin deletes an admitted case, a golden set holding admitted cases, a golden run an admitted case replays, or the workflow | `release.gate.cases_removed` (`via`: `fixture`, `golden_set`, `golden_run`, `workflow` or `data_subject`, with the cases and required cases it took) |
| A builder asks; an approver decides; a request goes stale or expires | `release.gate.case_request.requested`, `.decided`, `.canceled`, `.timed_out` |
| A gate save | `release.gate.updated`, with the cases it newly admitted and, when it drops a golden set, the admitted cases it drops |
| An admin's [data-subject delete](./production-capture.md#data-subject-lookup) takes a case, or results of a job | `release.gate.cases_removed` (`via: data_subject`) for admitted cases, and `release.jobs.evidence_removed` naming the jobs it made stale |

Removing an admitted case, clearing required or deleting the golden run an admitted case replays counts as loosening the gate; the audit metadata's `loosened` names the cases.

Admitting a case changes no golden set, so a replay job that already ran the case is judged again with it counted. Admitting a case the job never ran (one added after it was queued) makes the job stale, since it holds no result for a case that now counts. Adding or removing a pending case does not make earlier jobs stale; an admin removing an admitted case does not either (the remaining admitted cases are still covered, and the removal is audited). A [data-subject delete](./production-capture.md#data-subject-lookup) is the exception: erasure is a legal obligation, so an admin's delete is never refused, even when it takes admitted or required cases with a golden run. It is audited as loosening the gate, and every replay job that held a result it removed is stale for good: the job is marked not release-eligible ("a data-subject delete removed some of this job's case results after it ran"), so the gate and any pending release approval stop accepting it, and the job has to run again. On an unenforced gate, and for jobs queued before admission existed, any case added or removed makes earlier jobs stale as before. Lifting enforcement keeps the admission state but ignores it: an unenforced gate counts every case and ignores required marks, exactly as before admission existed. Enforcing the gate again restores it, so cases that were waiting, or were added while the gate was not enforced, still wait. Gates enforced before this release admit every case their sets held, once, when the API first starts with migration 36, so their jobs judge as they did. After that an enforced gate that has no stored admission (for example one edited directly in the database) fails closed: it counts nothing until an admin admits its cases.

### Deleting a workflow

A workflow's gate and release history outlive it. Ids the server picks (duplicate, external import) skip an id that still has a gate or releases. A workflow created or imported again under the same id on purpose inherits the gate; its old releases do not make it runnable, since rollback only returns to a version whose hash matches what was released. With the gate on and nothing loadable published, production refuses runs until a new version is published through the gate. Pending release requests for a deleted workflow are canceled.

## Release requests

A release request appears in **Approvals** next to paused runs, with the version, its hash, the replay job, the gate's findings and the requester's reason. **Approve and publish** publishes exactly that version and hash; **Reject** needs a reason.

A request is refused (and canceled) when it went stale: the version's hash changed, who may approve it changed (the gate's approvers, self-approval or enforcement, which only an admin can change on an enforced gate), or another version was published after the request. Approving also judges the version again, under the gate's admission and policy at that moment: if the gate now blocks it worse than when the request was made, the approval is refused with `409`, the answer lists the current reasons (`details.reasons`), and the request is canceled as stale. Worse means a kind of reason the request did not have (an admin required a case the job did not pass, admitted a case the job never ran, or the request's replay job is gone) or a worse measure of one it had (an admin admitted a case the job failed, so the pass rate fell further below the minimum). Reasons are compared by kind and measure, not by wording: better numbers, or a case waiting for admission, change nothing. A builder adding or deleting cases that wait for admission, adding a golden set whose cases all wait, saving the gate unchanged, or tightening its policy by an amount the job still meets, therefore never cancels a pending request; a tightening the job fails does, through the same comparison. Each uncovered or stale set, each override, each ineligible reason and the gate's scorers count as their own kind of reason, and a golden run's age never counts as getting worse. Requests made before this rule existed still go stale on any change to the gate's settings. It expires after the approvers' timeout (7 days by default) and is then listed as `timed_out`. Each requester gets their own request for a version: asking again returns your pending request, while a colleague asking for the same version gets a separate one; requests made stale by a change of who approves are canceled when anyone asks again. Approvers from a project that cannot read the workflow do not see the request; people who can read it but not publish it cannot decide it. Requests are audited as `release.approval.requested` and `release.approval.decided`.

## History and rollback

**Releases** lists every publish: version, verdict (`passed`, `approved`, `overridden`, `ungated`, `rollback`), who, when, from which version, the reason and the replay job, and every [unpublish](#unpublish) (verdict `unpublished`). **Roll back** returns production to a version that was published before (with the same hash), with a reason; it skips the gate, since that version already shipped. It needs `workflow:publish`, and an admin on an enforced gate. It is audited as `release.rolled_back`.

A published or released version is pinned: version retention never prunes it. The pinned set therefore grows with every release; there is no pruning for released versions in this release, so expect it to grow until an admin-only prune is added.

## Unpublish

**Unpublish** takes the live version down: from then on every production entry point (production webhooks, schedules, app triggers, chat, forms, API-key runs, queued runs, sub-workflow calls from production runs and the MCP gateway) runs the draft, the latest save, exactly as for a workflow that was never published. It is in the Publish dialog (from the version pill) and on the **Releases** card. A confirmation names the live version and says production runs the draft; the reason is optional and goes to the history and the audit log.

- It needs `workflow:publish`, the same permission as publishing: admins and builders (and project roles that grant it). Operators and viewers cannot unpublish. While the gate is **on and enforced**, only an admin (the global admin role; a project admin who is a builder globally is refused) can unpublish: a builder gets `403`, the refusal is audited as `release.unpublish.refused`, and the UI hides the button and says why. The check is made again inside the unpublish transaction, so a gate enforced a moment earlier is honoured. With the gate switched off or only observing, builders keep it. Rollback and deleting the workflow differ here: they follow the gate's enforced flag even when the gate is switched off. History times never go backwards: an entry written on an instance whose clock is behind takes the time of the newest entry, so with clock skew between instances a time can be off by at most that skew, while the order is always the order of the writes.
- The release gate never blocks it, enforced or not, and no approval is needed: it is the way out of a bad release. With a gate on, the confirmation and the API answer say plainly that the gate does not check the draft: production runs the ungated draft, and every save goes live, until a version is published again. Deactivating a gated workflow still stops production.
- The dialog sends the version it named (`expectedVersion`): if someone published or rolled back meanwhile, it answers `409` ("v5 is live now, not v4") and changes nothing, so you never take down a version you did not see. API calls without `expectedVersion` take down whatever is live.
- When nothing is published (a second unpublish included) it answers `409` and records nothing. Two unpublishes at the same time, on one API instance or two, record one entry.
- It is refused with `409` when the draft's webhook, form or MCP trigger paths are served by another workflow, as a publish would be. While unpublished, the draft serves those paths and claims them, gated or not.
- Runs already in progress finish on the version they started with, a paused run included.
- The history records an `unpublished` entry: who, when, the reason and which version was live (`version`). It is audited as `release.unpublished` (version, reason, whether a gate was on and enforced).
- Publishing again afterwards is an ordinary publish, through the gate when it is on. **Roll back** works as before: it returns production to a version that was published before (the one just unpublished included), with a reason, and on an enforced gate only an admin may roll back.
- A pending release request goes stale once production is unpublished, as when another version is published.
- A workflow created again under a gated id still fails closed: the unpublish belongs to the workflow it was made on.

## Permissions

Publishing, rollback, unpublish and deciding a release request need `workflow:publish` on the workflow's project. Admins, builders, project admins and editors have it; operators and viewers do not, and a custom role can grant it. Changing the gate needs `workflow:write`; turning it on when nothing is published also needs `workflow:publish`, since that publishes the baseline in your name. A workflow the user cannot read answers `404` on every release route, and one they can read but not change `403`. `PROJECT_ISOLATION=strict` applies as everywhere else.

## API

- `GET /api/workflows/:id/release-gate` → `{ gate }`
- `PUT /api/workflows/:id/release-gate` (`{ enabled, enforced?, datasetIds, candidateOptions? (including scorers?), policy?, requireApproval?, approvers? }`) → `{ gate }`
- `POST /api/workflows/:id/publish` (`{ version, workflowHash?, replayRunId?, override?: { reason }, requestApproval?: { reason } }`) answers `200 { release }`, `202 { verdict: "needs_approval", approvalRequestId }` or `409 { verdict: "blocked", reasons, replayRunId?, canRequestApproval }`
- `GET /api/workflows/:id/releases` → `{ releases, publishedVersion }`
- `POST /api/workflows/:id/rollback` (`{ version, reason }`) → `{ release }`
- `POST /api/workflows/:id/unpublish` (`{ reason?, expectedVersion? }`) → `{ release, productionRuns: "draft", gateEnabled, gateEnforced, notice }`; `403` when the gate is on and enforced and the caller is not an admin; `409` when nothing is published or `expectedVersion` is not the live version
- `GET /api/workflows/:id/release-state` → `{ state: { draftVersion, publishedVersion, aheadBy, gateEnabled, gateEnforced, productionRefused, unpublishedAt, canPublish, canEditGate } }`
- `GET /api/workflows/:id/publish-preview?version=&replayRunId=` → `{ preview }`, the verdict publishing would get now; on an enforced gate `preview.stats.admission` holds `{ admitted, pending, pendingNotPassing, required, requiredFailures: [{ id, name, problem }] }`
- `GET /api/workflows/:id/release-gate/cases` → `{ cases: { enforced, cases: [{ fixtureId, datasetId, datasetName, name, recordingId, admission: "admitted" | "pending", required, requestId, requestKind }], counts: { admitted, pending, required }, canAdmit, canRequest } }` (an unenforced gate answers `enforced: false` and no cases)
- `POST /api/workflows/:id/release-gate/cases/admit` and `/reject` (`{ fixtureIds, reason? }`, admins) → `{ cases }`
- `PUT /api/workflows/:id/release-gate/cases/:fixtureId/required` (`{ required }`, admins) → `{ cases }`
- `POST /api/workflows/:id/release-gate/cases/requests` (`{ action: "admit" | "remove", fixtureIds, reason }`, `workflow:write`) → `202 { request }`, decided in Approvals
