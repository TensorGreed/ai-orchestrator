---
title: "MCP tool policy: allow, deny or require approval"
term: "MCP tool policy"
topic: security
definition: "A set of rules, enforced outside the model, that decides whether a given agent or client may call a given MCP tool with given arguments: allow it, deny it, or hold it for a person to approve."
description: "Tool policy rules decide which agent or client may call which MCP tool with which arguments: allow, deny or ask a person first."
related: [least-privilege, shadow-mode, write-tool, tool-annotations, approval-gate]
guide: [/learn/security/least-privilege-for-agents]
---

# MCP tool policy

**A set of rules, enforced outside the model, that decides whether a given agent or client may call a given MCP tool with given arguments: allow it, deny it, or hold it for a person to approve.**

MCP says how tools are listed and called, not who may call what. The tools spec asks servers to "implement proper access controls" and says there "SHOULD always be a human in the loop with the ability to deny tool invocations". OWASP's MCP cheat sheet asks for least privilege "per MCP server and per tool" and explicit confirmation for "destructive, financial, or data-sharing operations". A tool policy is where those requirements become rules.

A useful rule names a few things:

- **Who**: a role, an agent's workflow or a gateway client.
- **What**: a server and a tool name or pattern, such as `delete_*`.
- **When**: optionally, conditions on the arguments (`env` equals `prod`) or on the tool's declared hints.
- **Effect**: allow, deny or require approval.

Three design points matter. Enforce the rules in code at call time, not in the prompt, because text in the context can talk a model out of its instructions. Hide denied tools from the model's list too, so it does not try them. And let a narrower rule beat a broader one, so an exception can sit inside a wide deny.

## Example

| Effect | Scope | Result |
|---|---|---|
| deny | tool `delete_*`, project Finance | no deletes in Finance, for anyone |
| require approval | tool `issue_refund`, `amount` greater than 500 | big refunds wait for a person |
| allow | tool `issue_refund`, `amount` greater than 500, role admin | admins' big refunds go through without the wait |

## Common confusion

Tool policy is not the same as the server's own authorization. An OAuth scope says what the token may do at the server; a tool policy says what this agent, in this context, should do with it. You usually want both.

## In L2M

Optional, and off until an admin adds a rule. [MCP tool policy](/product/mcp-tool-policy) rules allow, deny or require approval by project, role, server, tool pattern, arguments, annotation hints, workflow or gateway client. With no matching rule a call is allowed, deny beats allow unless an allow is strictly narrower, and any rule can run in [shadow mode](/product/mcp-tool-policy#shadow-mode) first.

## Further reading

- [MCP specification 2025-11-25: tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org)
