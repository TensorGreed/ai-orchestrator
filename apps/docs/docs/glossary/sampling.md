---
title: "MCP sampling: a server borrows the client's model"
term: "Sampling (MCP)"
topic: mcp
definition: "An MCP server asking the client to run a model call on its behalf, so a tool can use the client's model without its own API key."
description: "Sampling lets an MCP server ask the client to run a model call for it. Why it needs limits, and why the 2026-07-28 MCP revision deprecates it."
related: [mcp-client, mcp-host, elicitation, budget, human-in-the-loop]
guide: [/learn/mcp/tools-resources-prompts]
---

# Sampling (MCP)

**An MCP server asking the client to run a model call on its behalf, so a tool can use the client's model without its own API key.**

A server sends `sampling/createMessage` with `messages`, a `maxTokens` limit and, optionally, a `systemPrompt` and `modelPreferences`. The client picks the model, runs the completion and returns the answer. The specification frames the benefit as letting servers use AI "with no server API keys necessary", while clients "maintain control over model access, selection, and permissions". A client has to declare the `sampling` capability before a server may ask.

Servers do not name an exact model. `modelPreferences` holds `hints` (model names, treated as substrings, in order of preference) and three priorities from 0 to 1: `costPriority`, `speedPriority` and `intelligencePriority`. The spec puts it plainly: "Hints are advisory—clients make final model selection". Since 2025-11-25 a server may also pass `tools`, if the client declared `sampling.tools`.

The spec says there "SHOULD always be a human in the loop with the ability to deny sampling requests", and that clients SHOULD rate-limit them. The reason is simple: the server writes the prompt, reads the answer and spends the client's tokens.

## Example

A summarize tool needs a model. Mid-call it asks:

```json
{ "jsonrpc": "2.0", "id": 9, "method": "sampling/createMessage",
  "params": { "messages": [{ "role": "user",
      "content": { "type": "text", "text": "Summarize: ..." } }],
    "modelPreferences": { "hints": [{ "name": "small" }], "costPriority": 0.9 },
    "maxTokens": 300 } }
```

The client runs its own cheap model, returns `role`, `content`, `model` and `stopReason`, and the tool uses the summary.

## Common confusion

Sampling is not the server calling a model provider; the client does the calling, on its own account. And deprecated does not mean removed: the 2026-07-28 revision deprecates sampling (with roots and logging), so "new implementations should not add support", but it stays in the specification for a deprecation window of at least twelve months. The suggested migration is for servers to "integrate directly with LLM provider APIs". In 2026-07-28, a sampling request travels inside an `input_required` result rather than as the server's own request.

## In L2M

Sampling is **off by default**. An admin turns it on per server in the registry, with a token cap (1024 by default), an allowed-models list and a limit of requests per tool call (3 by default). Inside an agent, the request runs on the chat model attached to the node, with its own provider and secret (an allowed model the server hints at can take the model's place); direct MCP Tool nodes and gateway calls need a default model set on the server, or they refuse. An optional tool policy rule of kind `sampling` can deny it by model name, and tokens are counted on the tool call that triggered them ([sampling](/product/mcp-server-registry#sampling-a-server-asks-the-model-for-a-completion)). L2M declares no `sampling.tools`.

## Further reading

- [MCP specification 2025-11-25: sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) (modelcontextprotocol.io)
- [MCP 2026-07-28 changelog: deprecated features](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
