---
title: "Human in the loop (HITL) for AI agents"
term: "Human in the loop"
topic: agents
definition: "A design in which a person can see, approve, change or stop an AI system's action before it takes effect, instead of the system acting alone."
description: "Human in the loop means a person can approve, change or stop an agent's action before it happens. Where the MCP spec says to use it and how."
related: [approval-gate, write-tool, tool-calling, least-privilege]
guide: [/learn/agents/human-in-the-loop, /learn/security/mcp-security-risks]
---

# Human in the loop

**A design in which a person can see, approve, change or stop an AI system's action before it takes effect, instead of the system acting alone.**

Agents are useful because they choose their own steps, and risky for the same reason. A person in the loop is the backstop for the steps that cannot be undone: sending money, deleting records, emailing customers, pushing code. The MCP Tools specification says that "there SHOULD always be a human in the loop with the ability to deny tool invocations", and that clients should ask for confirmation on sensitive operations and show tool inputs before calling the server. OWASP lists human approval for high-risk actions among the mitigations for prompt injection and excessive agency.

## Example

A support agent drafts a refund of $480. Instead of calling `issue_refund` at once, the run pauses. A team lead sees the customer, the amount and the agent's reasoning, lowers the amount to $240, and approves. The run resumes and makes the call once, with the edited amount.

## What makes it work

- **Pick the right steps.** Asking for every call trains people to click "approve" without reading. Gate the actions that change things outside the system.
- **Show the real arguments.** The person must see what will actually run, not a summary the model wrote.
- **Decide what a timeout means.** An unanswered request should fail safe.

## Common confusion

Human in the loop is not human review of logs afterwards. Review after the fact helps you learn; only a decision before the action prevents harm.

## In L2M

All optional: an **Approval Gate** node pauses a run until a person decides, with timeouts and editable fields; **Ask before write tools** pauses before any MCP write tool an agent calls; and a [tool policy](/product/mcp-tool-policy#require-approval) rule can require approval for specific tools or arguments. See [Approvals](/product/approvals) and the guide [Human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls).

## Further reading

- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) (owasp.org)
