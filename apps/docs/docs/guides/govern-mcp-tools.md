---
title: "Govern MCP tools: allow and deny rules, write tools, telemetry"
description: "A step-by-step guide to MCP tool governance in L2M: classify tools, write allow and deny rules, gate write tools after untrusted content, watch calls."
---

# Govern MCP tools

MCP servers hand agents real capabilities: create an issue, write a file, run a query. **MCP tool governance** means deciding which of those tools each agent, person and client may use, enforcing it where the call is made rather than only in a UI, and being able to show afterwards what was called.

You need it as soon as an MCP server offers a tool that changes something, or as soon as people with different roles run the same agents. This guide sets it up in L2M, self-hosted, in five steps. It assumes your servers are in the [MCP server registry](../product/mcp-server-registry.md).

Nothing changes on an existing install until an admin adds a rule: a tool that no rule matches is allowed.

## 1. See what you are governing

Open **MCP → Tools**. It lists every tool of every registered server, from each server's current snapshot, with:

- its annotations (read-only, destructive, idempotent, open world), which the server itself declares;
- its **Policy** column: what policy means for you in the active project (blocked, destructive, write or read-only);
- calls, errors, p95 latency and cost from telemetry.

Filter by **read-only or write** and **destructive** to find the tools that need a decision first. Selecting a tool shows its schemas, a policy decision for any role and project, and the workflows that use it.

## 2. Classify read-only and write tools

Every tool is either read-only or a write tool, decided in this order:

1. an admin's **manual override** on the server's Tools table (**Mark read-only** or **Mark write**);
2. the server's own `readOnlyHint` annotation;
3. otherwise, a **write** tool.

Annotations are hints from the server, not guarantees. Review the tools that matter and override where the server is wrong: a `delete_records` tool labelled read-only should be marked **write**. **Auto (annotation)** hands the decision back to the server. Servers configured inline on a node have no registry entry, so only their annotations count.

## 3. Write allow and deny rules

Open **MCP → Policies**. A rule has an effect (`allow`, `deny` or **Needs approval**), a project (one or all), roles (empty means every role), a server (empty means any), a tool pattern (`*` globs) and optional conditions on the call's arguments or data labels. Under **Advanced** you can add an annotation condition or limit the rule to some workflows or gateway clients.

How rules combine:

- no matching rule: allowed;
- a matching deny: denied, unless a matching allow or Needs approval rule is **strictly narrower** than it, which carves an exception;
- otherwise a matching Needs approval rule: the call waits for a person;
- deny wins every tie, then Needs approval, then allow.

Common rules:

| Goal | Rule |
| --- | --- |
| No destructive tools for operators | deny, roles `operator`, annotation condition **destructive** |
| No deletes in one project | deny, project `Finance`, pattern `delete_*` |
| Viewers get one tool on a server | deny server `GitHub` for `viewer`; allow `search_issues` on server `GitHub` for `viewer` |
| No inline stdio servers | deny, server `stdio_mcp` (registered stdio servers are not affected) |
| A person approves pushes to production | Needs approval, pattern `push*`, condition `repo` **is one of** `acme/prod` |
| No PII to an outside tool | deny, server `Search`, condition **run data has label** `pii` |

Not sure about a rule yet? Turn on **Shadow mode**: the rule is only recorded on each call, with what it would have decided, so you can check real traffic before you enforce it.

Before saving, use **Test a tool** on the same page: pick a project, role, server and tool, paste example arguments, and see the decision, the matched rule and why, and what shadow rules would do. The same check is available as `POST /api/mcp/policies/evaluate`.

## 4. Block write tools where they don't belong

Two switches act on write tools without writing rules:

- **No write tools** (editor **⋯** menu): every write tool is blocked for agents and MCP Tool nodes in that workflow. Use it for workflows that should only read, such as a support bot that looks things up.
- **Ask before write tools…** (same menu): agents pause for a person's approval before each write-tool call, in the Approvals inbox. [Human approval for agent tool calls](./human-approval-for-agent-tool-calls.md) covers it.

## Untrusted content and write tools

The riskiest moment for an agent is just after it has read something from outside: a public webhook body, a web page, a tool result. Text planted there can try to steer the next tool call (prompt injection). L2M labels every run's data with where it came from (its **provenance**: `trusted` for schedules, `user` for a signed-in person's runs, `untrusted_external` for webhooks and other outside triggers), and tool rules can test those labels. See [Data labels and destinations](../product/data-labels-and-destinations.md).

You don't need to write those rules by hand. All of these are optional, and with none of them on every workflow runs as before.

- **Approve writes only after untrusted content** (editor **⋯** → **Ask before write tools…**). This is the light version of the write-tool gate. A call to a write tool waits for an admin's approval only while the agent's context holds `untrusted_external` content. Calls before that, and calls to read-only tools, run straight away. The switch is saved at once as a tool rule for this workflow alone (`require_approval`, `not_read_only`, `label_present untrusted_external`). Builders can turn it on or off; once an admin has edited that rule, only an admin can turn it off. Save the workflow before you use it.
- **Safety presets** (**MCP → Policies → Safety presets**, admin). These are two ready-made global rules:
  - **Untrusted content ⇒ write tools need approval**: the same rule as the switch, for every workflow.
  - **Sensitive data ⇒ no open-world tools**: a deny on open-world tools while the context holds `sensitive` data.

  A preset is added in **shadow mode**, so at first it only records what it would have done. Check its shadow hits, or simulate it on recorded calls, then **Enforce** it from the rule list. Enforcing goes through the usual checks: it is refused if it would set aside a deny that is enforced now.

A rule with a `sensitive` or data class condition turns on label tracking for every run while it is enabled. Node outputs are then scanned for data classes, so the condition can match. Rules on `untrusted_external`, `user` or `trusted` need no scan.

### Which tools are open world

A tool is **open world** when what it is given can leave your control. A tool's own `openWorldHint` is a claim by the server, so L2M checks the server's destination tier first:

| Server | Open world? |
|---|---|
| An admin's override on the tool (**Tools** table → **Mark open world** / **Mark not open world**) | as set |
| A vendor or public destination | yes, whatever the hint says |
| Unclassified (no destination row matches its host, or it has no endpoint) | yes: it fails closed |
| Local or private (a `localhost` or private-network host, a stdio process, or a destination row you added) | the tool's `openWorldHint` decides; a missing hint means yes |

The server's **Tools** table shows each tool's value and where it came from. To mark an internal server as private, add a [data destination](../product/data-labels-and-destinations.md) for its host. If some enabled rule already uses `open_world` or `not_open_world`, this tightens it: a tool that says `openWorldHint: false` on a public or unclassified server now counts as open world.

### Seeing the labels

Each tool call records the label names it was decided with on the run trace and on its telemetry row. Data class names are recorded only for runs that tracked labels. No values are ever recorded. The simulator uses these recorded labels:

- `untrusted_external`, `user` and `trusted` conditions are decided for every recorded call.
- `sensitive` and class conditions are decided only for runs that tracked labels.
- Calls recorded before labels were kept stay **undetermined**.

Gateway calls carry no labels, so label conditions never match them.

## 5. Check enforcement and watch calls

Policy is enforced in the runtime:

- **Discovery.** When an agent or supervisor starts, denied tools are removed before the model sees the tool set, including the tools of its workers.
- **Every call.** Each call is checked again. A model that asks for a hidden tool by name gets a tool error naming the rule; a direct MCP Tool node fails with the same message and is not retried.
- **Gateway.** Clients of the [MCP gateway](./self-hosted-mcp-gateway.md) are evaluated with their own role, and denied tools are absent from their `tools/list`. A call that needs approval returns an "approval pending" error; after an admin approves it under **Gateway approvals**, the client retries the same call.

To see it, run a workflow and open the agent node's **Trace** tab. The **Tool policy** block says which role the run was evaluated as and lists every hidden tool with the reason, for example `calculator hidden by policy Viewers: no calculator`. The built-in `mock-mcp` server leaves `calculator` unannotated, so it counts as a write tool and is handy for trying the switches.

Then watch usage on each server's **Tools** table and on **MCP → Overview**: calls, p50 and p95 latency, errors, tokens and cost per tool. Blocked calls count as failed calls. Rule edits and classification overrides appear in **MCP → Changes** and in the audit log (`mcp_policy.*` events).

## How it works

A run is evaluated with one role, its **subject**: the signed-in user for manual runs, the workflow's creator for webhooks, schedules and other triggers, or the client's role for gateway calls. Rules and overrides are read when each agent or MCP Tool node starts, so a change applies to the next node that runs. The full evaluation order, rule kinds (tools, resources, prompts, sampling) and the trace format are in [MCP tool policy](../product/mcp-tool-policy.md).

## What it does not do

- It does not verify what a tool actually does: classification relies on annotations or your override.
- Two different globs, or two different sets of conditions, are never treated as nested, so an allow with one does not carve an exception from a deny with another.
- No write tools does not apply to gateway calls; use a rule scoped to the toolset's policy project.

## Next steps

- Reference: [MCP tool policy](../product/mcp-tool-policy.md), [MCP control plane](../product/mcp-control-plane.md), [MCP server registry](../product/mcp-server-registry.md)
- Guides: [Least privilege from real runs](./least-privilege-from-real-runs.md), [Run a self-hosted MCP gateway](./self-hosted-mcp-gateway.md), [Human approval for agent tool calls](./human-approval-for-agent-tool-calls.md)
- See the **MCP → Tools** page with its policy column in the [live demo](https://lsquarem.com/demo/){target="_self"}
