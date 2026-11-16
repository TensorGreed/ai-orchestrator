---
title: "Idempotency: when an agent can safely retry"
term: "Idempotency"
topic: mcp
definition: "The property of an action that has the same effect whether it runs once or several times with the same input, so repeating it after a lost answer does no harm."
description: "An idempotent action has the same effect if it runs twice. Why that decides whether an agent may retry a tool call, with examples of safe and unsafe tools."
related: [tool-annotations, write-tool, mcp-tool, circuit-breaker, human-in-the-loop]
guide: [/learn/mcp/tool-annotations]
---

# Idempotency

**The property of an action that has the same effect whether it runs once or several times with the same input, so repeating it after a lost answer does no harm.**

Retries are where it matters. A request goes out, the connection breaks, and no answer comes back. Did the server act? The client cannot know. If the action is idempotent, it can send it again: the end state is the same either way. If not, it may do the thing twice.

RFC 9110 calls a method idempotent when "the intended effect on the server of multiple identical requests with that method is the same as the effect for a single such request". PUT, DELETE and GET qualify; POST does not. The RFC says a client should not retry a non-idempotent request automatically unless it has some means to know the request is actually idempotent, or that the first one was never applied.

It covers the intended effect, not the response: deleting an order twice leaves it deleted, though the second call may answer "not found".

MCP carries the same idea in <Term id="tool-annotations">tool annotations</Term>. `idempotentHint: true` says "calling the tool repeatedly with the same arguments will have no additional effect on its environment". It defaults to `false` and only means something for a tool that is not read-only. It is only a hint: the specification says clients should never base tool use decisions on annotations from untrusted servers.

## Example

- `get_order` (read-only): safe to repeat.
- `set_ticket_status(id, "closed")`: idempotent. Closing a closed ticket changes nothing.
- `add_comment(id, text)`: not idempotent. A retry posts the comment twice.
- `create_refund(order, amount)`: not idempotent, and costly to repeat, unless the server accepts a client-chosen key and ignores a second request with the same key.

## Common confusion

Idempotent is not read-only. A read-only tool changes nothing; an idempotent <Term id="write-tool">write tool</Term> changes something once and then stops changing it. Every read-only tool is idempotent, but not the other way round.

## In L2M

L2M's MCP clients follow a [safe re-send rule](/product/mcp-2026-07-28#the-safe-re-send-rule). After a broken connection, a timeout or a response stream that ended early, a tool call is sent again only when the tool counts as read-only (by an admin's mark in [tool policy](/product/mcp-tool-policy#read-only-classification), or else the server's `readOnlyHint`) or the server sets `idempotentHint: true`. A tool with no mark and no annotations counts as unsafe. Any other call fails with the error kind `outcome_unknown` (or `timeout` after a timeout), which says the tool may or may not have run, so a workflow can decide what to do. The rule is always on for 2026-07-28 servers; for older servers it is on by default. [MCP error -32000: Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed) shows where this comes up.

## Further reading

- [RFC 9110, section 9.2.2: Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2) (rfc-editor.org)
- [MCP specification 2025-11-25: schema, ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations) (modelcontextprotocol.io)
