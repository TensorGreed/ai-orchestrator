---
title: "MCP tool annotations: readOnlyHint and the others"
term: "Tool annotations"
topic: mcp
definition: "Optional hints an MCP server attaches to a tool definition, saying whether the tool is read-only, destructive, idempotent or reaches the outside world; clients must treat them as untrusted."
description: "Tool annotations are hints a server gives about a tool: read-only, destructive, idempotent, open world. The spec says to treat them as untrusted."
related: [write-tool, mcp-tool, mcp-tool-policy, rug-pull]
guide: [/learn/mcp/tool-annotations]
---

# Tool annotations

**Optional hints an MCP server attaches to a tool definition, saying whether the tool is read-only, destructive, idempotent or reaches the outside world; clients must treat them as untrusted.**

A tool's name and description tell the model what the tool does. Annotations tell the client how risky it is, so the app can decide what to show, confirm or block. The 2025-11-25 schema defines five fields, with defaults for when a hint is missing:

| Field | Meaning when `true` | Default |
|---|---|---|
| `title` | (text) a human-readable name | none |
| `readOnlyHint` | does not modify its environment | `false` |
| `destructiveHint` | may perform destructive updates (only meaningful when not read-only) | `true` |
| `idempotentHint` | repeating the call with the same arguments has no further effect (only meaningful when not read-only) | `false` |
| `openWorldHint` | may interact with external entities, like a web search | `true` |

The defaults lean towards caution: a tool that says nothing counts as a write tool that may destroy data and reach the outside world.

The schema is blunt about trust: annotations "are not guaranteed to provide a faithful description of tool behavior", and the tools page adds that clients "MUST consider tool annotations to be untrusted unless they come from trusted servers". A hint helps an honest server explain itself. It does not stop a dishonest one.

## Example

```json
{ "name": "delete_branch",
  "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false } }
```

A client can ask a person before this call and skip the question for a `readOnlyHint: true` tool such as `list_branches`.

## Common confusion

Annotations are not permissions. A server that marks `drop_table` as read-only has not made it read-only; only your own policy, scoped credentials and review can do that. A server can also change its hints after you trusted them, a form of <Term id="rug-pull">rug pull</Term>.

## In L2M

L2M keeps the hints from `tools/list`, shows them as chips and lets [tool policy](/product/mcp-tool-policy#annotation-conditions) match on them, reading missing hints with the spec's defaults. An admin's read-only or write mark on a registered server's tool replaces `readOnlyHint` ([read-only classification](/product/mcp-tool-policy#read-only-classification)).

## Further reading

- [MCP specification 2025-11-25: schema, ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
