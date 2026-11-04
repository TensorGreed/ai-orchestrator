---
description: "Let an L2M agent call another workflow as one tool with the Workflow Tool node: derived input schema, tool rules, labels, approvals, replay and spend."
---

# Workflow Tool: Call Another Workflow from an Agent

The **Workflow Tool** node turns another workflow into one tool an agent can call. Attach it to an Agent or Supervisor `Tool` port and pick the workflow. The child runs in the same run, in this process, with the agent's call as its input; its output is the tool result.

Use it when a step is already a workflow (a lookup with retrieval and a guard, a ticket triage flow) and you want an agent to decide when to run it.

## What the agent sees

The tool is derived from the child workflow's entry trigger:

1. An **Expose as MCP Tool** trigger: its tool name, description and input schema.
2. Otherwise a **Sub-Workflow Trigger**: its description and input schema; the name comes from the workflow name.
3. Otherwise one free-text `input` argument, which the child also gets as its user prompt (`{{user_prompt}}`).

**Tool name** and **Description for the model** on the node override the derived ones. The panel previews the result.

The child gets the arguments as its input (each argument at the top level, and all of them under `arguments`).

## Limits

Workflow tools follow the same rules as Execute Workflow:

- **Depth and cycles.** At most 10 workflows deep; a workflow already on the call stack (the agent's own workflow included) is refused. Both come back to the agent as a tool error.
- **Project scope.** The child must be in the same project, or shared to it with execute rights. It runs with its own project's secrets, knowledge bases and session stores. A workflow the run may not use fails the agent node with the reason.
- **Approvals.** If the child stops for an approval, the call fails with a message the agent can act on; the child is not kept waiting. Put the approval in its own run, or approve the call in the parent instead (below).

## Governance

A workflow tool is governed as the MCP server `workflow:<workflowId>`:

- **Tool rules** naming server `workflow:<id>` deny it, ask for approval, or allow it, like any MCP tool. A denied workflow tool is hidden from the model.
- **Write-tool approval.** A workflow tool counts as a write unless the node turns on **Read-only workflow**, so a workflow with write-tool approval on asks before each call. Turn on read-only only for a workflow that changes nothing outside the run.
- **Guard** checks the call's arguments and result like any tool call, under the parent run's profiles; the child runs under them too.
- **Labels.** The labels of the agent's context at the call go to the child as its input labels, and the child's output labels come back on the result. Untrusted content in the call therefore reaches the child's own tool rules.
- **Telemetry and replay.** Each call writes an MCP tool call row (adapter `l2m-workflow`). A recorded run's cassette holds the call, so a replay answers it from the recording and never runs the child.
- **Spend.** The child's model calls count in the run's usage and budget alerts, each priced by its own model.

## Across instances

To call a workflow on another L2M instance, or to give it its own execution, budget and Guard stack, expose it through a toolset on the MCP gateway and add that endpoint as an HTTP MCP server. See [Expose a Workflow as an MCP Tool](./workflow-as-mcp-tool.md).

## Related

- [Agent loop](./agent-loop.md)
- [Built-in agent tools](./built-in-agent-tools.md)
- [Approvals for agent tool calls](../guides/human-approval-for-agent-tool-calls.md)
