# Release gate and publish

A workflow has a **draft** (the latest save) and, once you publish, a **published version**. Production traffic runs the published version; the editor keeps running the draft. With a **release gate** on, a version reaches production only after a replay job of that exact version passed over the workflow's [golden sets](./golden-sets.md), under the policy in force when you publish.

Nothing changes for a workflow that was never published: every entry point runs the latest save, as before.

## Which version runs where

| Started from | Runs |
| --- | --- |
| Production webhooks (`/webhook/:path`, `POST /api/webhooks/execute`, `/stream`) | the published version |
| Schedules, app triggers (Slack, GitHub, Stripe, Telegram, Discord, polling triggers) | the published version |
| Chat (`/api/chat/:workflowId`), forms, the MCP Server Trigger, the MCP gateway's workflow tools | the published version |
| The execution queue | the published version when the job runs |
| A sub-workflow called from any of the above | the child's published version (its draft when it was never published) |
| The editor (**Run**, `/execute`), `/webhook-test/:path`, retries, the manual trigger, eval runs, replays | the draft, or the candidate a replay names |

A run paused on an approval resumes on the version it started with, even when another version is published meanwhile. A production webhook routes by the published version's path: a path you changed in the draft answers only on `/webhook-test/` until you publish. Schedules and app triggers re-register from the published version when you publish or roll back.

If the published version can no longer be loaded, production refuses the run instead of falling back to the draft.

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

- **Golden sets**: one or more of the workflow's sets. A job must cover all of them.
- **Policy**: minimum pass rate (default 100%), maximum regressions (default 0), minimum cases (default 3), maximum cost and p95 latency increase (no limit by default), no new guard blocks (on), errored cases count as failures (on), oldest golden run (default 30 days), required scorers.
- **MCP answers**: strict (default) or lenient. A strict gate refuses a job that replayed MCP calls leniently. A job that let any MCP write call reach a live server never passes a gate; a server whose mode is unknown counts as live writes.
- **Only plain jobs count**: guard-profile, MCP-mode, live-read and model overrides do not change a job's workflow hash, so a job that ran with any setting the gate's own candidate options do not name (an override, `models` other than `live`, `ignorePaths`, `numberTolerance`, repeats, aggregation or comparison other than the gate's, or a field this release does not know) is not proof for publishing. The reasons name the setting. The budget (`maxCostUsd`) does not count.
- **Approvers**: roles and users, and whether the requester may approve their own release (off by default). Approvers must also be allowed to publish the workflow. With **Every publish needs an approver**, a passing publish becomes a release request too.

The job is judged when you publish, under the policy then: loosening the policy lets an older job pass, and tightening it blocks a job that passed before. A job completed with `compare: baseline_rerun` judges regressions against the baseline's own result, so old golden runs are not held against it.

### Enforced gates

An admin can **enforce** a gate. Then only an admin can turn it off, lift enforcement or loosen it (lower the pass rate, allow more regressions, raise or remove a limit, remove a golden set, accept older golden runs, stop replaying strictly, widen or remove approvers, allow self-approval). A builder can still tighten it. A refused change answers `403` naming what it loosens.

## Release requests

A release request appears in **Approvals** next to paused runs, with the version, its hash, the replay job, the gate's findings and the requester's reason. **Approve and publish** publishes exactly that version and hash; **Reject** needs a reason.

A request is refused (and canceled) when it went stale: the version's hash changed, the gate's settings changed, or another version was published after the request. It expires after the approvers' timeout (7 days by default). Approvers from a project that cannot read the workflow do not see the request; people who can read it but not publish it cannot decide it. Requests are audited as `release.approval.requested` and `release.approval.decided`.

## History and rollback

**Releases** lists every publish: version, verdict (`passed`, `approved`, `overridden`, `ungated`, `rollback`), who, when, from which version, the reason and the replay job. **Roll back** returns production to a version that was published before, with a reason; it skips the gate, since that version already shipped. It is audited as `release.rolled_back`.

A published or released version is pinned: version retention never prunes it.

## Permissions

Publishing, rollback and deciding a release request need `workflow:publish` on the workflow's project. Admins, builders, project admins and editors have it; operators and viewers do not, and a custom role can grant it. Changing the gate needs `workflow:write`. A workflow the user cannot read answers `404` on every release route, and one they can read but not change `403`. `PROJECT_ISOLATION=strict` applies as everywhere else.

## API

- `GET /api/workflows/:id/release-gate` → `{ gate }`
- `PUT /api/workflows/:id/release-gate` (`{ enabled, enforced?, datasetIds, candidateOptions?, policy?, requireApproval?, approvers? }`) → `{ gate }`
- `POST /api/workflows/:id/publish` (`{ version, workflowHash?, replayRunId?, override?: { reason }, requestApproval?: { reason } }`) answers `200 { release }`, `202 { verdict: "needs_approval", approvalRequestId }` or `409 { verdict: "blocked", reasons, replayRunId?, canRequestApproval }`
- `GET /api/workflows/:id/releases` → `{ releases, publishedVersion }`
- `POST /api/workflows/:id/rollback` (`{ version, reason }`) → `{ release }`
- `GET /api/workflows/:id/release-state` → `{ state: { draftVersion, publishedVersion, aheadBy, gateEnabled, gateEnforced } }`
- `GET /api/workflows/:id/publish-preview?version=&replayRunId=` → `{ preview }`, the verdict publishing would get now

On the Postgres store every release route answers `501`, and every entry point runs the draft.
