---
title: "Tool calling (function calling) in LLMs, explained"
term: "Tool calling"
topic: agents
definition: "A model's structured request to run one named tool with JSON arguments, instead of answering in text. The application runs the tool and returns the result."
description: "Tool calling lets a model return a structured request to run a function instead of text. How the round trip works and what can go wrong."
related: [agent-loop, mcp-tool, ai-agent]
---

# Tool calling

**A model's structured request to run one named tool with JSON arguments, instead of answering in text. The application runs the tool and returns the result.**

Also called function calling. The model does not run anything itself. It picks a tool from the definitions it was given (a name, a description and a JSON Schema for the arguments) and fills in the arguments. Whether the call runs, and how, is up to the application.

## Example

The calculator tool of L2M's bundled mock MCP server takes one argument, `expression`. A model that wants 17% of 2,340 asks for:

```json
{ "name": "calculator", "arguments": { "expression": "2340 * 0.17" } }
```

With MCP, the client sends this to the MCP server as a `tools/call` request and passes the result back to the model as a tool message.

## What can go wrong

- The model names a tool that does not exist, or sends arguments that do not match the schema. The application should reject the call and tell the model.
- The model calls a tool it should not. The MCP specification says a person should be able to deny tool invocations, and that clients should ask for confirmation on sensitive operations.

## In L2M

Tools reach the model from MCP Tool nodes attached to an agent. Optionally, admins can allow, deny or require approval for calls: see [Govern MCP tools](/guides/govern-mcp-tools).

## Further reading

- [MCP specification: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (modelcontextprotocol.io)
