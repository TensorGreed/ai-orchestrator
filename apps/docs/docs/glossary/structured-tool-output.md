---
title: "Structured tool output and outputSchema in MCP"
term: "Structured tool output"
topic: mcp
definition: "A tool result returned as JSON in structuredContent, besides the text content. A tool that declares an outputSchema must return results that match it."
description: "An MCP tool can declare an outputSchema and return structuredContent that clients validate. Why it helps, and how it differs from model structured outputs."
related: [mcp-tool, tool-calling, breaking-change, tool-annotations]
guide: [/learn/mcp/tools-resources-prompts]
---

# Structured tool output

**A tool result returned as JSON in structuredContent, besides the text content. A tool that declares an outputSchema must return results that match it.**

A plain MCP tool result is a list of content blocks, usually text. That suits a model, but code downstream would have to parse prose. Since the 2025-06-18 revision a tool can also return a JSON object in `structuredContent`, and can describe its shape in advance with an `outputSchema` in `tools/list`. The 2025-11-25 rules are:

- If a tool declares an output schema, servers "MUST provide structured results that conform to this schema", and clients "SHOULD validate structured results against this schema".
- For backwards compatibility, a tool that returns structured content "SHOULD also return the serialized JSON in a TextContent block", so clients that ignore `structuredContent` still see the data.

The 2026-07-28 revision loosens the types: output schemas may use any JSON Schema 2020-12 keywords, and `structuredContent` may be any JSON value, not just an object.

## Example

A weather tool declares `"outputSchema": { "type": "object", "required": ["temperature", "conditions"], ... }` and answers:

```json
{ "content": [{ "type": "text",
    "text": "{\"temperature\": 22.5, \"conditions\": \"Partly cloudy\"}" }],
  "structuredContent": { "temperature": 22.5, "conditions": "Partly cloudy" } }
```

A client can now check `temperature` is a number before a later step relies on it.

## Common confusion

The specification is explicit: `structuredContent` "is server-produced result data and is unrelated to LLM "structured outputs" (schema-constrained model generation)". One describes what a tool returns; the other constrains what a model writes. An output schema is also a contract, and its compatibility rules run the other way from input rules. Making an optional output property required is safe, because consumers only get more; making an optional input argument required breaks every caller that leaves it out.

## In L2M

When a tool declares an output schema, L2M checks `structuredContent` against it. A missing or non-matching object fails the call with a message naming the problem; results flagged `isError` are not checked, and a schema that cannot be compiled is skipped with a warning. L2M expects an object: an array or a plain value in `structuredContent` fails the call, even though 2026-07-28 allows it. Later nodes read fields from the MCP Tool node's `structured` output, and the server registry diffs output schemas with the reversed rules ([structured output](/product/mcp-server-registry#structured-output)). Through the [MCP gateway](/product/mcp-gateway), a tool whose output is a JSON object returns it as `structuredContent` next to the JSON text; the gateway's `tools/list` declares no output schemas.

## Further reading

- [MCP specification 2025-11-25: tools, structured content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP 2025-06-18 changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog) (modelcontextprotocol.io)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
