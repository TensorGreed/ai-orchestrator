---
title: "MCP client: the connection inside an AI app"
term: "MCP client"
topic: mcp
definition: "The part of an AI application that holds one connection to one MCP server: it negotiates the protocol version and capabilities, then sends that server's requests and receives its replies."
description: "An MCP client is the connection a host app opens to one MCP server. What it negotiates, what it must check, and how it differs from the host."
related: [mcp-host, mcp-server, model-context-protocol, mcp-session]
guide: [/learn/mcp/what-is-mcp]
---

# MCP client

**The part of an AI application that holds one connection to one MCP server: it negotiates the protocol version and capabilities, then sends that server's requests and receives its replies.**

The word "client" is easy to misread. In MCP it is not the app you install. The app is the <Term id="mcp-host">host</Term>, and the host creates one client for each server it connects to. The specification puts it plainly: each client has "a 1:1 relationship with a particular server". An IDE connected to a file server, a ticket tracker and a search API runs three clients side by side.

A client's job is narrow but strict:

- **Open the session.** It sends `initialize` first, with the latest protocol version it supports and its own capabilities (for example, whether it can answer sampling or elicitation requests). If the server answers with a version the client does not support, the client should disconnect.
- **Respect what was agreed.** Both sides may only use the capabilities they declared.
- **Keep servers apart.** One server's client never sees another server's traffic. Combining results is the host's job, which is why the host, not the client, decides what the model may call.

## Example

A host connects to a remote ticket server. Its client posts:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2025-11-25", "capabilities": {},
              "clientInfo": { "name": "my-agent", "version": "1.0.0" } } }
```

The server replies with `2025-11-25` and `"tools": { "listChanged": true }`. The client sends `notifications/initialized`, then `tools/list`, and hands the tool list to the host.

## Common confusion

People often call the whole chat app or IDE "the MCP client". As shorthand that is fine. In the spec, though, the host owns consent, user authorization and the model; the client is just one connection. When a security rule says "the client MUST", it usually means the code that talks to that one server.

## In L2M

L2M is an MCP client whenever an agent or MCP Tool node calls a server: it connects over <Term id="streamable-http">Streamable HTTP</Term> or <Term id="stdio-transport">stdio</Term> and, by default, asks for protocol version `2025-06-18` in `initialize` and sends the negotiated `MCP-Protocol-Version` header afterwards. Speaking 2026-07-28 to a server is opt-in, per connection or deployment-wide. See the [MCP server registry](/product/mcp-server-registry#progress-and-cancellation). Through the [MCP gateway](/product/mcp-gateway), L2M also plays the server role for other clients.

## Further reading

- [MCP specification 2025-11-25: architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) (modelcontextprotocol.io)
