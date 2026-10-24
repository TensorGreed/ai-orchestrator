# Approval gates

An **Approval Gate** pauses a run until a person decides. You choose who may decide, what happens when nobody does, and which values the approver may change before the run goes on. Every request and decision is audited, recorded in the run's signed manifest and sent through your notification channels.

The paused run is saved like any other approval pause, so it survives restarts. Nothing leaves your deployment.

## The Approval Gate node

Put the gate on a DAG edge. It has three outputs:

| Output | When |
| --- | --- |
| `approved` | An approver approved. The item that came into the gate goes on, with the approver's edits applied on top. |
| `rejected` | An approver rejected. When nothing is connected to `rejected`, the gate fails instead, so try/catch and the node's on-error setting apply. |
| `timed_out` | Nobody decided in time and the timeout outcome is **Fallback branch**. When nothing is connected to `timed_out`, the timeout is handled as a rejection. |

Settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| Message | `Approval required to continue.` | Shown to the approver. A template: `Send '{{reply}}'?` |
| Approver roles | none | Global roles that may decide: `admin`, `builder`, `operator`, `viewer`. A listed role matches exactly; listing `builder` does not include admins. |
| Approver users | none | User ids or emails that may decide. An email entry matches by email, so an account re-registered with the same email matches it again; use ids to name one specific account. |
| Allow self-approval | off | Whether the person who started the run may decide it. Listing them as an approver does not change this. |
| Timeout (minutes) | 1440 (one day) | 1 to 43,200 (30 days). |
| Timeout outcome | Reject | **Reject**, or **Fallback branch** (the `timed_out` output). |
| Require a reason to reject | on | Rejections without a reason are refused. |
| Editable fields | none | Up to 20 fields the approver may edit before approving (see below). |

With no roles and no users listed, any operator, builder or admin may decide. In every case the approver must have **execute** access to the workflow's project: a user who cannot run the workflow cannot approve it, whatever the gate lists. For a gate inside a sub-workflow, that means execute access to the project of every workflow from the top-level run down to the gate. Roles and project access are checked again when the decision is taken, so a demotion or a removal from the project takes effect at once.

Self-approval is checked against the person who started the run. A run started by a webhook, a schedule or another automatic trigger has no known requester; the card says **Requester unknown (automatic trigger)**, and anyone who passes the approver check may decide it, including whoever sent the webhook if they are also an approver.

The approved output carries the incoming fields, the edited values and an `approval` record:

```json
{
  "reply": "Hello Ana, thanks!",
  "approved": true,
  "approval": {
    "decision": "approve",
    "outcome": "approved",
    "actedBy": "lead@example.com",
    "reason": "Warmer",
    "decidedAt": "2026-10-23T09:12:44.120Z",
    "requestId": "apr_…",
    "editedFields": ["reply"]
  },
  "_branchHandle": "approved"
}
```

A gate cannot be the body of a Loop node: loop bodies run inline and cannot pause part-way. Gate the loop's input or its output instead. Any other approval inside a Loop body (an Execute Workflow node whose sub-workflow has a gate, or an agent with the write-tool gate) fails the loop with "Approvals cannot pause inside a Loop body".

### Nothing skips a gate

A gate is a separation-of-duties control, so whoever can start a run cannot step around it:

- A gate's output never comes from pinned data or from `nodeOutputs` sent with a run. A workflow with a pinned gate does not validate, the pin route refuses an Approval Gate (`400`), and the editor offers no **Pin output** for one.
- A run that would start after a gate is refused before any node runs: `startNodeId` or a single-node run of a node downstream of a gate, on `/api/workflows/:id/execute` and on `/api/executions/:id/retry`, fails with "This run would start after Approval Gate '…'. Start at or before the gate." The check covers every node the run would execute, not just the start node: starting on a sibling branch that merges below the gate, or at a worker or other node attached to an agent below the gate, is refused too. Starting at the gate itself is allowed; it pauses as usual.
- A node below a gate cannot also be attached, as a worker or tool, to an agent that does not wait for the gate: validation reports `approval_gate_attachment_bypass` and the workflow cannot be saved or run. Attach such a node only to agents below the gate.
- A gate cannot continue on error. **Continue Anyway** would run the approved branch after a rejection with nowhere to go, or after a request that could not be rendered (for example when the expression sandbox fails). Validation reports `approval_gate_continue_on_error` and the editor does not offer it; a stored workflow that still has it, by `onError` or `errorConfig.continueOnFail`, stops at the failed gate. Use **Stop** or the error branch. A Human Approval node follows the same rule (`human_approval_continue_on_error`): after a rejection, or a message that cannot be rendered, the next step does not run.
- [Replays](./golden-runs.md) are the exception: they answer a gate from the decision the golden run recorded.

Human Approval nodes keep their earlier behaviour here (pins and start nodes work as before). A pinned Human Approval node makes validation report a `human_approval_pinned` warning, because runs then skip the pause. Human Approval is not a separation-of-duties control: use an Approval Gate when the person who runs the workflow must not be able to approve or skip it.

### Approve with edits

Each editable field has a key, a label, a type (`string`, `text`, `number`, `boolean` or `json`), an optional value template the approver starts from (for example `{{reply}}`), whether it is required and, for text, a maximum length. When the gate pauses, the templates are rendered from the run and the approver sees the proposed values.

Edits are checked before the run resumes: only listed keys, values of the field's type, required fields not empty, text within its maximum length, and no more than 64 KiB in total. A refused edit answers `400` with one message per field. The values land on the approved output under their keys, so a field named `reply` replaces the incoming `reply` for every node after the gate. Edits are ignored on a rejection or a timeout.

## Who can see and decide: project authorization

Approvals use the same project authorization as runs (see [Authentication and RBAC](../security/auth-rbac.md)), always against the workflow as it is now, not the project stored when the run paused:

- A request whose workflow you cannot read answers `404`, the same as a run that does not exist, on approve, reject and approve with edits, and nothing is written for it. `GET /api/approvals?workflowId=` and `?executionId=` answer `404` for a workflow or run you cannot read, or one that does not exist.
- A request you can read but whose workflow you may not run (no `workflow:execute`, or no execute access to a sub-workflow along its path) is listed with **canDecide** false and answers `403`.
- The inbox lists only requests of workflows you can read, filtered before the limit. A workflow moved to another project takes its requests with it. Requests of a deleted workflow's runs are admin-only, and stay so if a new workflow later reuses the id. Inbox items and approval audit events carry the workflow's current project.
- With `PROJECT_ISOLATION=strict`, only members of the workflow's project (and admins) see or decide its requests.
- Admins pass these checks, as everywhere else; the approver list and the self-approval rule still apply to them.

A resumed run runs as the person who decided, like any run that person starts: it reaches only its workflow's project (its secrets, MCP servers, knowledge bases, sub-workflows), and that person needs `secret:use` there for secrets. An admin approving does not widen what the run can reach. A resume that runs later on the queue or after a restart looks the person up again: if they were deleted, replaced by another account with the same email, or lost execute access in the meantime, the resume is refused (audited as `approval.resume_refused`) and the request is pending again for someone who may decide it. The same check covers every workflow along the sub-workflow path and the gate's approver rules (the self-approval rule applies only when the decision is taken). A timeout resumes as the person who started the run, looked up again by id and email, who must still be able to execute the workflow (so a user without `secret:use` cannot have the fallback branch use a secret by letting a request expire). If that person was deleted or lost execute access, no branch runs: the request stays `timed_out`, the run ends as an error and the refusal is audited as `approval.resume_refused`. A run that no user started (a webhook, a schedule) times out with no user, as it began.

## The approvals inbox

**Approvals** in the sidebar lists the requests of workflows you can read: **Pending** and **Decided**, with a filter. Each request shows the message, the workflow, the node, who started the run, when it expires, who may decide and, for a gate inside a sub-workflow, the path to it. When you may not decide a request the card says why: you started the run, you are not one of its approvers, or you lack execute access to the project.

On the **Runs** page, a run waiting for approval has **Review approval**, which opens the inbox at that run.

The inbox also holds requests that are not paused runs: [release requests](./release-gate.md#release-requests) to publish a version, and **Gate cases** requests to admit cases to an enforced release gate or remove admitted ones (see [Case admission](./release-gate.md#case-admission-and-required-cases)). A Gate cases card lists the cases and the requester's reason; **Approve** admits or removes them, **Reject** needs a reason. Both kinds are decided against the gate as it is when you decide: a Gate cases request whose gate settings changed since it was asked is stale and says so, and approving a release request judges the version again first.

Only one decision counts. Once a person decides (or the request times out), any other decision for the same request answers `409`. A decision sent for an older request of a run that has since paused again answers `409` too, and so does a decision on a request past its expiry (its timeout outcome applies instead). A run you cannot see answers `404`, whatever state it is in.

A recorded decision is never lost. Claiming the paused run and recording the decision happen in one transaction. If the resume then cannot start (the queue refuses it) or fails, the run waits again and the request is pending again with the same expiry; the decision answers `503` "Could not resume the run; decide again".

### What else asks for approval

The inbox also shows the other pauses that wait for a person:

| Kind | Who may decide | Reason to reject |
| --- | --- | --- |
| Approval Gate | As configured on the gate | As configured (required by default) |
| Agent write tool (below) | As configured on the workflow | Required |
| Human Approval node | Operators, builders and admins with execute access, the requester included | Optional |
| Guard `require_approval` | Same as Human Approval | Optional |

Human Approval nodes and guard hand-offs keep their earlier behaviour (the person who started the run may decide) so existing single-user setups do not stop at a request nobody else can answer. Use an Approval Gate when you need separation of duties.

## Timeouts

Each request expires at the time it paused plus its timeout. The instance holding the leader lease checks for expired requests every `APPROVAL_SWEEP_INTERVAL_MS` (default one minute) and once at startup, so requests that expired while the API was down are handled as soon as it is back. An expired request resumes the run with a timeout, decided by `system`:

- an Approval Gate goes to `timed_out` (fallback outcome, when connected) or is handled as a rejection;
- every other kind is handled as a rejection ("Human approval timed out").

| Kind | Timeout |
| --- | --- |
| Approval Gate | The gate's setting (default 1440 minutes, one day) |
| Agent write tool | `writeToolApproval.timeoutMinutes` (default 1440) |
| Human Approval node | The node's `timeoutMinutes` |
| Guard node (route hand-off) and an agent's guard port | The guard node's `timeoutMinutes` (default now 1440, was 60) |
| Automatic guard profiles on an agent (no guard node) | 1440 minutes |

::: warning Behaviour change on upgrade
Before this release, Human Approval and guard hand-off timeouts were stored but never enforced. They are now. A run that was already waiting when you upgrade is **not** rejected at once: it gets one full timeout counted from the upgrade (the first start of the API with migration 32), and the API logs the ids of those runs once. Guard hand-offs without their own timeout now wait one day instead of an hour.
:::

## Sub-workflows

A gate inside a sub-workflow called by a sync **Execute Workflow** node pauses the whole run: the parent waits at its Execute Workflow node and the inbox shows the gate's own approvers and message, with the path from the parent. Approving resumes the sub-workflow from the gate, and the parent continues with the sub-workflow's output. A second gate in the sub-workflow pauses the parent again. This works at any depth.

Limits:

- Only the top-level run is saved. The sub-workflow's paused state travels inside the parent's, and the sub-workflow resumes with the definition it had when it paused.
- If the sub-workflow fails after it resumes and the Execute Workflow node has retries, a retry starts the sub-workflow from the beginning, so it asks for approval again; the decision is never reused for the retry. A rejection or a timeout is final: it is never retried, and only a failure after an approval is retried from the beginning.
- An **async** Execute Workflow node starts its sub-workflow without waiting; a gate there pauses that sub-workflow as a separate run of its own.

## Approval before write tools

A workflow can require approval before any of its agents calls an MCP **write** tool. In the editor, open **⋯ › Ask before write tools…** and turn it on (`settings.writeToolApproval`):

```json
{
  "writeToolApproval": {
    "enabled": true,
    "approverRoles": ["admin"],
    "approverUsers": [],
    "allowSelfApproval": false,
    "timeoutMinutes": 1440
  }
}
```

`allowSelfApproval` is off by default, as on a gate. On a single-user install that means nobody can approve your own runs; the dialog warns when nobody but you could approve, so add another approver or turn on **Let the person who started the run approve it**.

For this gate a tool is read-only only when an admin marked it read-only in the tool policy (the MCP servers page). The server's own `readOnlyHint` annotation is not trusted here: any server, including an inline one nobody reviewed, can label `delete_records` read-only. Every other tool, including one without annotations, counts as a write tool. (A server that claims both `readOnlyHint: true` and `destructiveHint: true` counts as a write tool everywhere, the [No write tools](./mcp-tool-policy.md#no-write-tools) setting included.)

Before the agent calls a write tool, the run pauses. The request shows the tool, its server and a preview of the arguments (up to 2,000 characters). The approval covers one call: this agent node, this server and tool and these exact arguments. Approving runs the agent node again; the approved call runs once and its result is kept in the paused run, encrypted at rest with the deployment's master key and handed back to the agent exactly as the tool returned it (a result over 256 KB is not kept, and the run asks again instead of answering from a truncated one). When the agent pauses again for its next write tool and that one is approved, the next re-run answers the earlier call from its stored result and never calls the tool again. If the model repeats an approved call with the same arguments within one re-run, or asks for the tool with other arguments, the run asks again. Rejecting fails the agent node with the reason. A timeout rejects. Supervisor workers follow the same setting (the approval is keyed to the worker node); a sub-workflow follows its own.

The gate applies to tools reached through an agent's tool port. A direct **MCP Tool** node is not gated by this setting; put an Approval Gate before it.

## Notifications

When a request is created and when one times out, L2M sends `approval.requested` and `approval.timed_out` through the notification channels (Slack, Teams, email). Channels configured in the environment receive them unless `NOTIFICATIONS_APPROVAL_EVENTS=false`; channels stored in the database receive them when their event list includes them. Set `APP_PUBLIC_URL` (for example `https://l2m.example.com`) to include a link to the inbox. Notification channels are not scoped to a project, so messages carry only the workflow, the run id, who may decide and the expiry (or the timeout outcome). The request's own text and proposed values stay in the inbox, where project access applies.

## Audit and the run manifest

Audit entries, in the `approval` category:

| Event | When |
| --- | --- |
| `approval.requested` | A run paused for a decision |
| `approval.decided` | Someone approved or rejected (outcome `success`), or was refused (outcome `denied`, with the reason: self-approval, not an approver, no project access) |
| `approval.timed_out` | The sweeper expired a request |
| `approval.resume_refused` | A queued or recovered resume was refused because the person who decided may no longer run the workflow or approve (the request is pending again), or a timeout was refused because the person who started the run may no longer run it (the run ends as an error) |
| `approval.canceled` | The paused run was canceled |

Decisions record the reason, the keys of the edited fields and a digest of the edits, not the edited values. The digest is HMAC-SHA256 over the canonical JSON of the edits, keyed with a random salt kept on the request row, so the audit entry and the manifest carry the same digest and a short edit cannot be guessed from an exported manifest. Reasons are masked for secret-looking values in both.

The [run manifest](../security/audit-bundles.md) lists gate decisions in `approvals` (like Human Approval decisions) and every request in `extensions.approvals.requests`: request id, node, kind, outcome (`approved`, `rejected`, `timed_out`, `canceled`, `pending`), who decided and when, the reason, the edited field keys, the edits digest and the sub-workflow path.

Decided requests are pruned with execution history (`EXECUTION_HISTORY_RETENTION_DAYS`). Deleting a workflow cancels its pending requests and keeps decided ones.

## The execution queue

When the API runs with the execution queue, a decision resumes the run on the queue: approve and reject answer `202 { queued: true }` and the run continues on a worker. Without the queue the resume runs inline and the response is the run result, as before.

If the API stops after a decision but before the resumed run is saved, the run stays in `resuming`. The leader re-drives it with the decision recorded for the pause it is in (never a decision from an earlier pause):

- at startup, at once on a single instance (`HA_ENABLED=false`);
- on every sweep, with or without the queue: with the queue when no queue item for that resume is waiting or running (after a one-minute grace); without the queue once the claim is older than `WORKFLOW_EXECUTION_TIMEOUT_MS` plus a margin, so a resume still running on another instance is never started twice.

A queued resume is tried once; when it fails the request goes back to pending and can be decided again, and the resume always applies the decision stored on the request, never one carried by an older queue item.

Resumes are **at-least-once**: a recovered resume runs the nodes after the gate again, so a side effect there can happen twice if the API stopped mid-resume.

## Replays

[Replays](./golden-runs.md) never wait for a person: an Approval Gate is answered with the decision the golden run recorded and routes the same way, and the write-tool gate does not pause.

## Not covered yet

- Postgres deployments: migration 32 creates the tables, but the Postgres store does not implement approvals yet. On Postgres the approvals routes answer `501`, no requests are recorded and no timeouts run; paused runs stay paused.
- Escalation, reminders and one-click approve links inside Slack, Teams or email messages.
- Groups as approvers; approvers are roles or individual users.
- Approval Gates inside Loop node bodies.
- Teams messages escape Markdown links and emphasis; a bare URL in a message may still be turned into a link by Teams.
