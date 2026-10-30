---
title: "Human approval for agent tool calls: pause, decide, prove it"
description: "Make AI agents ask a person before they call an MCP write tool: approve or reject in the Approvals inbox, and find each decision in the run's signed manifest."
---

# Human approval for agent tool calls

An agent that can call write tools can also call the wrong one, with the wrong arguments, at the wrong time. **Human-in-the-loop approval** stops the agent before a risky call, shows a person exactly what it is about to do, and continues only after they approve. For governance, the decision also has to be recorded where nobody can quietly change it later.

Use it for agents that send messages, change records, move money or touch production systems, and anywhere the person who starts a run should not be the one who approves it.

L2M does this on your own deployment: the agent pauses before an MCP **write** tool, the request lands in the **Approvals** inbox, and the decision goes into the audit log and into the run's Ed25519-signed manifest.

## 1. Turn on approval before write tools

In the editor, open the **⋯** menu, choose **Ask before write tools…** and turn it on. The setting is saved in the workflow as `settings.writeToolApproval`:

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

- **Approvers**: roles and users who may decide. Every approver also needs execute access to the workflow's project.
- **Self-approval** is off by default: the person who started the run cannot approve it. On a single-user install, add another approver or turn on **Let the person who started the run approve it**; the dialog warns you when nobody else could approve.
- **Timeout**: an undecided request is rejected after this many minutes (default one day).

## 2. Decide which tools count as write tools

For this setting, a tool is read-only **only** when an admin marked it read-only on the server's Tools table in the [MCP server registry](../product/mcp-server-registry.md). The server's own `readOnlyHint` is not trusted here, because any server can label a delete tool read-only. Every other tool, including one without annotations, pauses the run.

So mark the genuinely read-only tools (search, get, list) as **read-only** once, and every call to anything else asks first. [Govern MCP tools](./govern-mcp-tools.md) covers classification and the rules that hide tools altogether.

## 3. Run the agent and decide in the inbox

When the agent wants to call a write tool, the run pauses. **Approvals** in the sidebar shows the request with:

- the tool, its server and a preview of the arguments (up to 2,000 characters);
- the workflow, the node and who started the run;
- who may decide, and when the request expires.

On the **Runs** page, a waiting run has **Review approval**, which opens the inbox at that run. **Approve** runs the approved call once and lets the agent continue; **Reject** needs a reason and fails the agent node with it. Only the first decision counts; a second one answers `409`.

If your notification channels (Slack, Teams, email) are configured, they receive `approval.requested` and `approval.timed_out`. Set `APP_PUBLIC_URL` so the message links to the inbox.

## 4. See the decision in the audit trail

Every request and decision is written to the audit log (`approval.requested`, `approval.decided`, `approval.timed_out`, `approval.canceled`), including refused attempts such as self-approval.

The run's **signed manifest** lists every approval request in `extensions.approvals.requests`: request id, node, kind (`agent_tool` for this gate), outcome, who decided and when, and the reason. On the **Runs** page, expand the finished run to see its manifest and download its **Audit bundle**. Anyone with the deployment's public key can check the bundle offline:

```bash
pnpm l2m audit verify l2m-audit-<executionId>.zip --public-key audit-key.pub.pem
```

Exit code 0 means every file matches the signed index and the signature verifies with your key; 1 means the bundle was changed or signed by another key. Without `--public-key` the result is **SIGNER NOT VERIFIED** (exit 3), because a key embedded in the bundle proves nothing about who signed it.

## How it works

- **One approval, one call.** The approval covers this agent node, this server and tool, and these exact arguments. If the model asks for the tool again with other arguments, the run asks again.
- **No double calls.** The approved call's result is kept in the paused run, encrypted at rest, and handed back to the agent; a later re-run answers it from the stored result instead of calling the tool again.
- **Workers too.** Supervisor workers follow the same setting; a sub-workflow follows its own.
- **Survives restarts.** The paused run is saved like any approval pause, and expired requests are handled when the API comes back.

## Other ways to put a person in the loop

- A tool policy rule with the effect **Needs approval** (`require_approval`) asks for approval on matching calls only, for example pushes to `acme/prod`, whatever the workflow settings. It also covers direct **MCP Tool** nodes and [MCP gateway](../product/mcp-gateway.md) clients. When both the rule and **Ask before write tools** apply to a call, the inbox shows one request naming both. Admins decide a rule's approval, whatever approvers the write-tool settings name. See [Require approval](../product/mcp-tool-policy.md#require-approval).
- An **Approval Gate** node on a DAG edge pauses any workflow step, with approver rules, editable fields the approver can change before approving, and a fallback branch on timeout. A direct **MCP Tool** node is not covered by the write-tool setting, so put an Approval Gate before it.
- A **release gate** can send every publish of a new workflow version to an approver ([CI for AI agents](./ci-for-ai-agents.md)).

## What it does not do

- No escalation, reminders or one-click approve links inside Slack, Teams or email messages yet.
- Approvers are roles or individual users, not groups.
- Approvals cannot pause inside a Loop node body.

## Next steps

- Reference: [Approval gates](../product/approvals.md), [Audit bundles and signed run manifests](../security/audit-bundles.md), [MCP tool policy](../product/mcp-tool-policy.md)
- Guides: [Govern MCP tools](./govern-mcp-tools.md), [Run a self-hosted MCP gateway](./self-hosted-mcp-gateway.md)
- See the Approvals inbox in the [live demo](https://lsquarem.com/demo/){target="_self"}
