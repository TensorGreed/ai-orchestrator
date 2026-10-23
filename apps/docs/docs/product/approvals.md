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
| Approver users | none | User ids or emails that may decide. |
| Allow self-approval | off | Whether the person who started the run may decide it. Listing them as an approver does not change this. |
| Timeout (minutes) | 1440 (one day) | 1 to 43,200 (30 days). |
| Timeout outcome | Reject | **Reject**, or **Fallback branch** (the `timed_out` output). |
| Require a reason to reject | on | Rejections without a reason are refused. |
| Editable fields | none | Up to 20 fields the approver may edit before approving (see below). |

With no roles and no users listed, any operator, builder or admin may decide. In every case the approver must have **execute** access to the workflow's project: a user who cannot run the workflow cannot approve it, whatever the gate lists.

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

A gate cannot be the body of a Loop node: loop bodies run inline and cannot pause part-way. Gate the loop's input or its output instead.

### Approve with edits

Each editable field has a key, a label, a type (`string`, `text`, `number`, `boolean` or `json`), an optional value template the approver starts from (for example `{{reply}}`), whether it is required and, for text, a maximum length. When the gate pauses, the templates are rendered from the run and the approver sees the proposed values.

Edits are checked before the run resumes: only listed keys, values of the field's type, required fields not empty, text within its maximum length, and no more than 64 KiB in total. A refused edit answers `400` with one message per field. The values land on the approved output under their keys, so a field named `reply` replaces the incoming `reply` for every node after the gate. Edits are ignored on a rejection or a timeout.

## The approvals inbox

**Approvals** in the sidebar lists the requests of workflows you can read: **Pending** and **Decided**, with a filter. Each request shows the message, the workflow, the node, who started the run, when it expires, who may decide and, for a gate inside a sub-workflow, the path to it. When you may not decide a request the card says why: you started the run, you are not one of its approvers, or you lack execute access to the project.

On the **Runs** page, a run waiting for approval has **Review approval**, which opens the inbox at that run.

Only one decision counts. Once a person decides (or the request times out), any other decision for the same request answers `409`. A decision sent for an older request of a run that has since paused again answers `409` too.

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

Each request expires at the time it paused plus its timeout. The instance holding the leader lease checks for expired requests every `APPROVAL_SWEEP_INTERVAL_MS` (default one minute) and once at startup, so requests that expired while the API was down are handled as soon as it is back. An expired request resumes the run with a timeout:

- an Approval Gate goes to `timed_out` (fallback outcome, when connected) or is handled as a rejection;
- every other kind is handled as a rejection ("Human approval timed out").

Human Approval nodes now enforce the timeout they always stored. A run that paused before this release gets its request when the API starts, expiring from when it paused, so a Human Approval run older than its timeout is rejected at the first startup after upgrading.

## Sub-workflows

A gate inside a sub-workflow called by a sync **Execute Workflow** node pauses the whole run: the parent waits at its Execute Workflow node and the inbox shows the gate's own approvers and message, with the path from the parent. Approving resumes the sub-workflow from the gate, and the parent continues with the sub-workflow's output. A second gate in the sub-workflow pauses the parent again. This works at any depth.

Limits:

- Only the top-level run is saved. The sub-workflow's paused state travels inside the parent's, and the sub-workflow resumes with the definition it had when it paused.
- If the sub-workflow fails after it resumes and the Execute Workflow node has retries, a retry starts the sub-workflow from the beginning (it may ask for approval again).
- An **async** Execute Workflow node starts its sub-workflow without waiting; a gate there pauses that sub-workflow as a separate run of its own.

## Approval before write tools

A workflow can require approval before any of its agents calls an MCP **write** tool. Turn on **Require approval before write tools** in the workflow settings (`settings.writeToolApproval`):

```json
{
  "writeToolApproval": {
    "enabled": true,
    "approverRoles": ["admin"],
    "approverUsers": [],
    "allowSelfApproval": false,
    "timeoutMinutes": 60
  }
}
```

A tool is a read-only tool when an admin marked it so on the MCP servers page or its server annotates it with `readOnlyHint: true`; every other tool, including one without annotations, counts as a write tool. This is the same classification the [No write tools](./mcp-tool-policy.md#no-write-tools) setting uses.

Before the agent calls a write tool, the run pauses. The request shows the tool, its server and a preview of the arguments (up to 2,000 characters). Approving runs the agent node again with that one call allowed: the approval covers this agent node, this server and tool and these exact arguments. If the model asks for the tool with other arguments on the re-run, the run asks again. Rejecting fails the agent node with the reason. A timeout rejects. Supervisor workers follow the same setting; a sub-workflow follows its own.

The gate applies to tools reached through an agent's tool port. A direct **MCP Tool** node is not gated by this setting; put an Approval Gate before it.

## Notifications

When a request is created and when one times out, L2M sends `approval.requested` and `approval.timed_out` through the notification channels (Slack, Teams, email). Channels configured in the environment receive them unless `NOTIFICATIONS_APPROVAL_EVENTS=false`; channels stored in the database receive them when their event list includes them. Set `APP_PUBLIC_URL` (for example `https://l2m.example.com`) to include a link to the inbox. Messages carry the workflow, the run, the message, who may decide and the expiry; values in the message that look like secrets are masked.

## Audit and the run manifest

Audit entries, in the `approval` category:

| Event | When |
| --- | --- |
| `approval.requested` | A run paused for a decision |
| `approval.decided` | Someone approved or rejected (outcome `success`), or was refused (outcome `denied`, with the reason: self-approval, not an approver, no project access) |
| `approval.timed_out` | The sweeper expired a request |
| `approval.canceled` | The paused run was canceled |

Decisions record the reason, the keys of the edited fields and a SHA-256 digest of the edits, not the edited values.

The [run manifest](../security/audit-bundles.md) lists gate decisions in `approvals` (like Human Approval decisions) and every request in `extensions.approvals.requests`: request id, node, kind, outcome (`approved`, `rejected`, `timed_out`, `canceled`, `pending`), who decided and when, the reason, the edited field keys, the edits digest and the sub-workflow path.

Decided requests are pruned with execution history (`EXECUTION_HISTORY_RETENTION_DAYS`). Deleting a workflow cancels its pending requests and keeps decided ones.

## The execution queue

When the API runs with the execution queue, a decision resumes the run on the queue: approve and reject answer `202 { queued: true }` and the run continues on a worker. Without the queue the resume runs inline and the response is the run result, as before.

If the API stops after a decision but before the resumed run is saved, the leader resumes it again with the recorded decision at the next startup (without the queue; with the queue, the queue retries its job).

## Replays

[Replays](./golden-runs.md) never wait for a person: an Approval Gate is answered with the decision the golden run recorded and routes the same way, and the write-tool gate does not pause.

## Not covered yet

- Postgres deployments: the `approval_requests` table is created by migration 32, but the Postgres store does not implement the approvals methods yet.
- Escalation, reminders and one-click approve links inside Slack, Teams or email messages.
- Groups as approvers; approvers are roles or individual users.
- Approval Gates inside Loop node bodies.
