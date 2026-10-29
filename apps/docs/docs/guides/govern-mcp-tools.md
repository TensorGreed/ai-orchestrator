---
title: "Govern MCP tools: allow and deny rules, write tools, telemetry"
description: "A step-by-step guide to MCP tool governance in L2M: classify read-only and write tools, write allow and deny rules, block write tools, and watch every call."
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

Open **MCP → Policies**. A rule has an effect (`allow` or `deny`), a project (one or all), roles (empty means every role), a server (empty means any), a tool pattern (`*` globs) and an optional annotation condition.

How rules combine:

- no matching rule: allowed;
- a matching deny: denied, unless a matching allow is **strictly narrower** than it, which carves an exception;
- deny wins every tie.

Common rules:

| Goal | Rule |
| --- | --- |
| No destructive tools for operators | deny, roles `operator`, annotation condition **destructive** |
| No deletes in one project | deny, project `Finance`, pattern `delete_*` |
| Viewers get one tool on a server | deny server `GitHub` for `viewer`; allow `search_issues` on server `GitHub` for `viewer` |
| No inline stdio servers | deny, server `stdio_mcp` (registered stdio servers are not affected) |

Before saving, use **Test a tool** on the same page: pick a project, role, server and tool (optionally with "No write tools") and see the decision, the deciding rule and every matching rule. The same check is available as `POST /api/mcp/policies/evaluate`.

## 4. Block write tools where they don't belong

Two switches act on write tools without writing rules:

- **No write tools** (editor **⋯** menu): every write tool is blocked for agents and MCP Tool nodes in that workflow. Use it for workflows that should only read, such as a support bot that looks things up.
- **Ask before write tools…** (same menu): agents pause for a person's approval before each write-tool call, in the Approvals inbox. [Human approval for agent tool calls](./human-approval-for-agent-tool-calls.md) covers it.

## 5. Check enforcement and watch calls

Policy is enforced in the runtime:

- **Discovery.** When an agent or supervisor starts, denied tools are removed before the model sees the tool set, including the tools of its workers.
- **Every call.** Each call is checked again. A model that asks for a hidden tool by name gets a tool error naming the rule; a direct MCP Tool node fails with the same message and is not retried.
- **Gateway.** Clients of the [MCP gateway](./self-hosted-mcp-gateway.md) are evaluated with their own role, and denied tools are absent from their `tools/list`.

To see it, run a workflow and open the agent node's **Trace** tab. The **Tool policy** block says which role the run was evaluated as and lists every hidden tool with the reason, for example `calculator hidden by policy Viewers: no calculator`. The built-in `mock-mcp` server leaves `calculator` unannotated, so it counts as a write tool and is handy for trying the switches.

Then watch usage on each server's **Tools** table and on **MCP → Overview**: calls, p50 and p95 latency, errors, tokens and cost per tool. Blocked calls count as failed calls. Rule edits and classification overrides appear in **MCP → Changes** and in the audit log (`mcp_policy.*` events).

## How it works

A run is evaluated with one role, its **subject**: the signed-in user for manual runs, the workflow's creator for webhooks, schedules and other triggers, or the client's role for gateway calls. Rules and overrides are read when each agent or MCP Tool node starts, so a change applies to the next node that runs. The full evaluation order, rule kinds (tools, resources, prompts, sampling) and the trace format are in [MCP tool policy](../product/mcp-tool-policy.md).

## What it does not do

- It does not verify what a tool actually does: classification relies on annotations or your override.
- Two different globs are never treated as nested, so an allow with one glob does not carve an exception from a deny with another.
- No write tools does not apply to gateway calls; use a rule scoped to the toolset's policy project.

## Next steps

- Reference: [MCP tool policy](../product/mcp-tool-policy.md), [MCP control plane](../product/mcp-control-plane.md), [MCP server registry](../product/mcp-server-registry.md)
- Guides: [Run a self-hosted MCP gateway](./self-hosted-mcp-gateway.md), [Human approval for agent tool calls](./human-approval-for-agent-tool-calls.md)
- See the **MCP → Tools** page with its policy column in the [live demo](https://lsquarem.com/demo/){target="_self"}
