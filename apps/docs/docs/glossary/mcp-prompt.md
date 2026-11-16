---
title: "MCP prompt: reusable templates from a server"
term: "MCP prompt"
topic: mcp
definition: "A reusable message template an MCP server offers, with named arguments, for a person or application to pick, rather than for the model to call."
description: "MCP prompts are message templates a server offers, with named arguments, for a person to pick. How prompts/get works and how prompts differ from tools."
related: [mcp-resource, mcp-tool, mcp-server, tool-poisoning, prompt-injection]
guide: [/learn/mcp/tools-resources-prompts]
---

# MCP prompt

**A reusable message template an MCP server offers, with named arguments, for a person or application to pick, rather than for the model to call.**

The specification calls prompts "user-controlled": they are meant for a person to choose explicitly, often as a slash command. They let a server's author ship the instructions that work best with their server, such as a review checklist or a triage format, so every user does not have to write their own.

A prompt has a `name` and, optionally, a `title`, a `description` and a list of `arguments`. Each argument has a `name` and may have a description and a `required` flag. The client lists prompts with `prompts/list` and fetches one with `prompts/get`, passing the arguments. The server returns `messages`: each has a `role` (`user` or `assistant`) and content, which can be text, an image, audio or an embedded resource. A server that declares `listChanged` sends `notifications/prompts/list_changed` when its prompts change.

## Example

```json
{ "jsonrpc": "2.0", "id": 2, "method": "prompts/get",
  "params": { "name": "code_review",
              "arguments": { "code": "def hello():\n    print('world')" } } }
```

The server answers with one user message, "Please review this Python code: ...", ready to send to a model. An unknown prompt name or a missing required argument is a `-32602` error.

## Common confusion

A prompt is not a tool. The model never calls a prompt; a person or the application picks it, and its text becomes part of what the model reads. That is also the risk: prompt text comes from the server and goes straight to your model. The spec says implementations "MUST carefully validate all prompt inputs and outputs to prevent injection attacks", and a server that quietly changes a prompt can steer your model the way <Term id="tool-poisoning">tool poisoning</Term> does.

## In L2M

Agent, Supervisor, LLM Call and chat model nodes have a **Server prompt** picker. The workflow builder picks a registered server's prompt, fills its arguments (templates allowed) and chooses whether it replaces the node's system or user message. L2M fetches the prompt each time the node runs, so the server's current version applies, and records what it used under `_serverPrompt` in the node's output ([using a server prompt](/product/mcp-server-registry#using-a-server-prompt)). The messages become one text: assistant turns are labelled, and images or binary parts are replaced by a short placeholder. Optional tool policy rules of kind `prompt` can deny prompts by name ([rule kinds](/product/mcp-tool-policy#rule-kinds)). The [MCP gateway](/product/mcp-gateway) serves tools only, not prompts.

## Further reading

- [MCP specification 2025-11-25: prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts) (modelcontextprotocol.io)
