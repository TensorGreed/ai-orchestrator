---
title: "Tool calling (function calling) in LLMs, explained"
term: "Tool calling"
topic: agents
definition: "A model's structured request to run one named tool with JSON arguments, instead of answering in text. The application runs the tool and returns the result."
description: "Tool calling lets a model return a structured request to run a function instead of text. How the round trip works and what can go wrong."
related: [agent-loop, mcp-tool, ai-agent, human-in-the-loop]
guide: [/learn/agents/what-is-an-ai-agent]
---

# Tool calling

**A model's structured request to run one named tool with JSON arguments, instead of answering in text. The application runs the tool and returns the result.**

Also called function calling. The model does not run anything itself. It picks a tool from the definitions it was given (a name, a description and a JSON Schema for the arguments) and fills in the arguments. Whether the call runs, and how, is up to the application.

## The round trip

1. The application sends the conversation plus the tool definitions.
2. The model replies with a tool call instead of text: a tool name, arguments and a call id.
3. The application runs the tool and sends the result back, tagged with the same call id.
4. The model reads the result and either answers or asks for another call.

A model may ask for several calls in one reply. Repeating this round trip until the model answers is the <Term id="agent-loop">agent loop</Term>.

## Example

The calculator tool of L2M's bundled mock MCP server takes one argument, `expression`. A model that wants 17% of 2,340 asks for:

```json
{ "name": "calculator", "arguments": { "expression": "2340 * 0.17" } }
```

With MCP, the client sends this to the MCP server as a `tools/call` request and passes the result back to the model as a tool message.

## What can go wrong

- The model names a tool that does not exist, or sends arguments that do not match the schema. The application should reject the call and tell the model, so it can correct itself.
- The model calls a tool it should not. The MCP specification says a person should be able to deny tool invocations, and that clients should ask for confirmation on sensitive operations.

## Common confusion

Tool calling is a model feature; [MCP](/glossary/model-context-protocol) is a protocol for where tools live. Each provider has its own tool-call format, and the application translates between it and MCP.

## In L2M

Tools reach the model from MCP Tool nodes attached to an agent. Optionally, admins can allow, deny or require approval for calls: see [Govern MCP tools](/guides/govern-mcp-tools).

## Further reading

- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
