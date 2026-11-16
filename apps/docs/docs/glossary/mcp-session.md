---
title: "MCP session: state between calls, and its removal"
term: "MCP session"
topic: mcp
definition: "Over Streamable HTTP, the state that ties a client's requests together: if the server returns an MCP-Session-Id when the client initializes, the client sends it with every later request."
description: "Up to 2025-11-25, an MCP session ties HTTP requests together with an MCP-Session-Id. The 2026-07-28 revision removes it in favour of explicit handles."
related: [streamable-http, mcp-client, mcp-gateway, stdio-transport]
guide: [/learn/mcp/transports]
---

# MCP session

**Over Streamable HTTP, the state that ties a client's requests together: if the server returns an MCP-Session-Id when the client initializes, the client sends it with every later request.**

In the 2025-11-25 revision a session begins with the `initialize` handshake, where client and server agree on a protocol version and capabilities. Over <Term id="streamable-http">Streamable HTTP</Term>, a server MAY then assign a session id in the `MCP-Session-Id` header of its `initialize` response. The rules are short:

- The id SHOULD be globally unique and cryptographically secure, and MUST use visible ASCII only.
- The client MUST send it on every later request.
- The server MAY end the session at any time and then answers the old id with 404; the client MUST then initialize again.
- A client that is done SHOULD send HTTP `DELETE` with the header.

Sessions make a server stateful. If sessions live in one process's memory, a load balancer has to send a client's requests to the same instance every time.

## What 2026-07-28 changes

The 2026-07-28 revision removes the `initialize` handshake, protocol-level sessions and the `Mcp-Session-Id` header. Each request carries its own protocol version and client capabilities in `_meta`, and list results may no longer vary per connection. A server that needs state across calls mints an explicit handle, such as a cart id, and receives it back as an ordinary tool argument. The security best practices then warn about "state handle hijacking": servers "MUST NOT treat possession of a state handle as authentication" and should bind handles to the authenticated user.

## Common confusion

A session is not a login. The 2025-11-25 security guidance says servers must not use sessions for authentication; the token on each request is what proves who is calling. And with <Term id="stdio-transport">stdio</Term> there is no session id at all: the connection is the child process.

## In L2M

The [MCP gateway](/product/mcp-gateway#the-endpoint) issues sessions to clients on 2025-11-25, 2025-06-18 and 2025-03-26. `initialize` returns an `Mcp-Session-Id`, the session is bound to the client and <Term id="toolset">toolset</Term> that opened it, `DELETE` ends it, and it closes after 30 idle minutes by default (`MCP_GATEWAY_SESSION_IDLE_MS`). Sessions live in the memory of one API instance; in a cluster, a request that reaches another instance gets 404 and the client starts a new session, so route each session to the instance that opened it ([MCP gateway sessions](/operations/cluster#mcp-gateway-sessions)). Serving 2026-07-28 clients without sessions is opt-in (`MCP_GATEWAY_MODERN_PROTOCOL=on`); their state is then kept per client token, toolset and user ([the MCP gateway in 2026-07-28](/product/mcp-2026-07-28#the-mcp-gateway)). As a client, L2M keeps the session id a server returns and sends it on later requests to that server.

## Further reading

- [MCP specification 2025-11-25: transports, session management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (modelcontextprotocol.io)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [MCP security best practices 2025-11-25: session hijacking](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) (modelcontextprotocol.io)
- [MCP security best practices (latest): state handle hijacking](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) (modelcontextprotocol.io)
