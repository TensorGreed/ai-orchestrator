---
title: "MCP tool: definition, schema and results"
term: "MCP tool"
topic: mcp
definition: "A named action an MCP server offers, described by a JSON Schema for its input, that a model can ask to call and a client runs with a tools/call request."
description: "An MCP tool is a named action with a JSON Schema input that a model can call through a server. How tools are listed, called and how errors return."
related: [tool-calling, mcp-server, tool-annotations, write-tool, tool-poisoning]
guide: [/learn/mcp/tools-resources-prompts, /learn/mcp/what-is-mcp]
---

# MCP tool

**A named action an MCP server offers, described by a JSON Schema for its input, that a model can ask to call and a client runs with a tools/call request.**

The MCP specification calls tools *model-controlled*: the model decides when to use one, based on its name and description. That makes the definition the part that matters most. It has a `name`, an optional `title`, a `description`, an `inputSchema` (JSON Schema for the arguments), and optionally an `outputSchema` and `annotations` such as `readOnlyHint`.

## Example

The calculator tool of L2M's bundled mock server, as a client sees it:

```json
{
  "name": "calculator",
  "description": "Evaluate a basic math expression containing numbers and + - * / operators.",
  "inputSchema": {
    "type": "object",
    "properties": { "expression": { "type": "string" } },
    "required": ["expression"]
  }
}
```

The client runs it with `tools/call` and the arguments `{"expression": "2340 * 0.17"}`. The result comes back as `content` (text, images and other items) and, when the tool declares an output schema, also as `structuredContent`.

## Two kinds of error

An unknown tool or a malformed request is a JSON-RPC protocol error. A failure inside the tool, including invalid arguments, is a normal result with `isError: true`, so the model can read what went wrong and try again with better arguments.

## Common confusion

A tool is not a resource. A resource is data the application chooses to read; a tool is something the model chooses to run, and it may change things. Annotations describe a tool's behaviour, but the specification says clients must treat them as untrusted unless the server is trusted.

## In L2M

An MCP Tool node attaches tools to an agent's `tool` port; see the [MCP node reference](/nodes/reference/mcp). The model sees each tool as `<adapter>__<tool>`, for example `mock-mcp__calculator` ([tool names](/runtime/agent-loop#tool-names-the-model-sees)).

## Further reading

- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
