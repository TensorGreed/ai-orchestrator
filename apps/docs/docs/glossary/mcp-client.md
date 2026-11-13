---
title: "MCP client: the connection inside an AI app"
term: "MCP client"
topic: mcp
definition: "The part of an AI application that holds one connection to one MCP server: it negotiates the protocol version and capabilities, then sends that server's requests and receives its replies."
description: "An MCP client is the connection a host app opens to one MCP server. What it negotiates, what it must check, and how it differs from the host."
related: [mcp-host, mcp-server, model-context-protocol, mcp-session]
guide: [/learn/mcp/hosts-clients-servers, /learn/mcp/what-is-mcp]
---

# MCP client

**The part of an AI application that holds one connection to one MCP server: it negotiates the protocol version and capabilities, then sends that server's requests and receives its replies.**

In MCP, the "client" is not the app you install. The app is the <Term id="mcp-host">host</Term>, and the host creates one client for each server it connects to. The specification puts it plainly: each client has "a 1:1 relationship with a particular server". An IDE connected to a file server, a ticket tracker and a search API runs three clients side by side.

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

People often call the whole chat app or IDE "the MCP client". That is fine as shorthand, but in the spec the host owns consent, user authorization and the model; the client is just one connection. When a security rule says "the client MUST", check what it is about: protocol rules (headers, versions, token audience) fall on the connection; rules about consent and what people see fall on the host.

## In L2M

L2M is an MCP client whenever an agent or MCP Tool node calls a server: it connects over <Term id="streamable-http">Streamable HTTP</Term> or <Term id="stdio-transport">stdio</Term> and, by default, asks for protocol version `2025-06-18` in `initialize` and, over HTTP, sends the negotiated `MCP-Protocol-Version` header afterwards. If a server speaks only 2026-07-28 and rejects `initialize`, L2M switches to 2026-07-28 for that server. Trying 2026-07-28 first is opt-in, per connection (`protocolMode`) or deployment-wide (`MCP_CLIENT_PROTOCOL_DEFAULT`). See the [MCP server registry](/product/mcp-server-registry#progress-and-cancellation). Through the [MCP gateway](/product/mcp-gateway), L2M also plays the server role for other clients.

## Further reading

- [MCP specification 2025-11-25: architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) (modelcontextprotocol.io)
