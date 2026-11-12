---
title: "Tool call: how a model asks to use a tool"
term: "Tool call"
description: "A structured request from a model to run one named tool with JSON arguments. The application runs the tool and returns the result to the model."
related: [agent-loop]
---

# Tool call

**A structured request from a model to run one named tool with JSON arguments. The application runs the tool and returns the result to the model.**

The model does not run anything itself. It picks a tool from the definitions it was given (a name, a description and a JSON Schema for the arguments) and fills in the arguments. Whether the call runs, and how, is up to the application.

## Example

The calculator tool of L2M's bundled mock MCP server takes one argument, `expression`. A model that wants 17% of 2,340 asks for:

```json
{ "name": "calculator", "arguments": { "expression": "2340 * 0.17" } }
```

With MCP, the client sends this to the MCP server as a `tools/call` request and passes the result back to the model.

## In L2M

Tools reach the model from MCP Tool nodes attached to an agent. Admins can allow, deny or require approval for calls: see [Govern MCP tools](/guides/govern-mcp-tools).

## Further reading

- [MCP specification: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (modelcontextprotocol.io)
