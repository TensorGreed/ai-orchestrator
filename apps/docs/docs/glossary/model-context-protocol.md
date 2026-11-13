---
title: "Model Context Protocol (MCP): definition"
term: "Model Context Protocol (MCP)"
topic: mcp
definition: "An open protocol that lets AI applications discover and use tools, data and prompt templates from separate servers through one standard set of JSON-RPC messages."
description: "The Model Context Protocol is an open standard for connecting AI apps to tools and data through servers. What it defines and what it leaves out."
related: [mcp-server, mcp-tool, mcp-client, mcp-gateway, tool-calling]
guide: [/learn/mcp/what-is-mcp]
---

# Model Context Protocol (MCP)

**An open protocol that lets AI applications discover and use tools, data and prompt templates from separate servers through one standard set of JSON-RPC messages.**

Before MCP, every AI app wired each integration in its own way. MCP fixes the interface instead: a server that speaks it works with any app that speaks it. The specification names three roles. A **host** is the AI application. Inside it, a **client** holds the connection to one **server**, and the server offers features: **tools** the model can call, **resources** (data the app can read) and **prompts** (templates a user can pick).

## Example

A coding assistant (the host) connects to a Git server and a ticket-tracker server. It sends `tools/list` to each, gives the tool definitions to its model, and when the model asks for `create_issue`, sends `tools/call` to the tracker. Neither server needs to know which model or app is on the other side.

## What MCP leaves out

MCP defines messages, not policy. Which tools a model may use, who approves a risky call, and how much a run may spend are up to the host. The specification says hosts must get the user's consent before invoking tools, and that tool descriptions should be treated as untrusted unless they come from a trusted server; it cannot enforce either at the protocol level.

## Common confusion

MCP is not a model feature and does not replace <Term id="tool-calling">tool calling</Term>. The model still asks for a tool in its own provider's format; MCP is how the application finds that tool and runs it on a server.

## In L2M

L2M is both sides of the protocol. As a client, agents use tools from MCP servers through [MCP Tool nodes](/extensions/mcp). As a server, the [MCP gateway](/product/mcp-gateway) serves workflows and registered tools to other <Term id="mcp-client">MCP clients</Term>, speaking protocol versions 2025-11-25, 2025-06-18 and 2025-03-26.

## Further reading

- [MCP specification 2025-11-25: overview](https://modelcontextprotocol.io/specification/2025-11-25) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
