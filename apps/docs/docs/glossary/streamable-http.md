---
title: "Streamable HTTP: the MCP transport for remote servers"
term: "Streamable HTTP"
topic: mcp
definition: "The MCP transport for servers reached over a network: every client message is an HTTP POST to one endpoint, and the server answers with a JSON body or a server-sent events stream."
description: "Streamable HTTP carries MCP over one HTTP endpoint with JSON or server-sent events. Sessions, Origin checks, and the 2026-07-28 stateless change."
related: [stdio-transport, mcp-session, mcp-server, mcp-gateway]
guide: [/learn/mcp/transports]
---

# Streamable HTTP

**The MCP transport for servers reached over a network: every client message is an HTTP POST to one endpoint, and the server answers with a JSON body or a server-sent events stream.**

MCP messages are JSON-RPC. A transport decides how they travel. With <Term id="stdio-transport">stdio</Term> the client starts the server itself; with Streamable HTTP the server is an independent process that many clients can reach at one URL, such as `https://example.com/mcp`. It replaced the older HTTP+SSE transport from the 2024-11-05 revision, which needed two endpoints.

How it works in the 2025-11-25 revision:

- **One endpoint.** The client POSTs each message and must accept both `application/json` and `text/event-stream`. For a request, the server picks: one JSON object, or an SSE stream that can carry progress notifications before the response.
- **Optional GET.** A client may open an SSE stream with GET to hear from the server unprompted. A server that offers none answers 405.
- **Sessions.** A server may return an `MCP-Session-Id` header with its `initialize` reply. The client then sends it on every request; a 404 means the session is gone and the client must initialize again. DELETE ends it.
- **Version header.** Every later request carries `MCP-Protocol-Version`.
- **Origin checks.** Servers must validate the `Origin` header and answer 403 when it is invalid, because DNS rebinding can let a web page reach a local server.

## Example

```http
POST /mcp HTTP/1.1
Accept: application/json, text/event-stream
MCP-Session-Id: 1868a90c
MCP-Protocol-Version: 2025-11-25

{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search","arguments":{"q":"refund"}}}
```

## Common confusion

Streamable HTTP is not "MCP over SSE". SSE is only one way a reply can come back, and many replies are plain JSON. Note too that the 2026-07-28 revision drops the `initialize` handshake and its connection-scoped session: each request carries its protocol version and capabilities in the message body. By default L2M speaks 2025-11-25 and earlier; 2026-07-28 is opt-in.

## In L2M

L2M's `http_mcp` adapter connects to remote servers over Streamable HTTP only, not the old HTTP+SSE transport. The [MCP gateway](/product/mcp-gateway#the-endpoint) serves each <Term id="toolset">toolset</Term> at `POST /mcp/<slug>` with sessions, SSE progress and an `Origin` allow-list, for protocol versions 2025-11-25, 2025-06-18 and 2025-03-26 by default. With `MCP_GATEWAY_MODERN_PROTOCOL=on` it also serves 2026-07-28 clients without sessions.

## Further reading

- [MCP specification 2025-11-25: transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: transports overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) (modelcontextprotocol.io)
