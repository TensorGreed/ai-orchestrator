---
title: "MCP \"Session not found\" (HTTP 404): causes and fixes"
sidebarTitle: "Session not found (404)"
description: "A Streamable HTTP MCP server answered 404 for an Mcp-Session-Id it no longer knows. Why it happens after restarts and scale-out, and how a client recovers."
level: intermediate
about: mcp-session
related: [mcp-session, streamable-http, mcp-gateway, mcp-client, mcp-server]
---

# MCP "Session not found" (HTTP 404)

An <Term id="mcp-server">MCP server</Term> using <Term id="streamable-http">Streamable HTTP</Term> answered `404 Not Found` because the `Mcp-Session-Id` your <Term id="mcp-client">MCP client</Term> sent belongs to a session the server no longer has: it restarted, the session expired, or the request reached a different server instance. The fix on the client side is to drop the old id and send a new `initialize`; the fix on the server side is to keep sessions alive across instances (sticky routing) or to stop depending on them.

## What it means

Sessions exist only in the Streamable HTTP transport of the session-based revisions, 2025-03-26 to 2025-11-25. In those revisions an <Term id="mcp-session">MCP session</Term> works like this:

1. The client sends `initialize`. The server MAY put a session id in an `MCP-Session-Id` header on that response.
2. The client MUST send the header on every later request.
3. The server MAY end the session at any time. After that it MUST answer requests carrying the old id with `404 Not Found`.
4. When a client gets `404` for a request that carried a session id, it MUST start a new session by sending a new `initialize` without a session id.

So a 404 with a session id is not a bug in itself. It is how the specification says "this session is over". The error people see is the client failing to follow rule 4: it keeps sending the dead id, or it gives up and shows the error.

The session lives wherever the server keeps it. Many servers keep sessions in the memory of one process. Anything that loses that memory, or sends the request to a process that never had it, produces this 404.

The current revision, 2026-07-28, removes protocol sessions and the `Mcp-Session-Id` header altogether. A server that speaks only 2026-07-28 should ignore the header and never mint one, so a session 404 should not come from it. See [MCP transports](/learn/mcp/transports#what-2026-07-28-changes).

## Causes (most to least likely)

1. **The server restarted.** A deploy, a crash or a container being rescheduled wipes in-memory sessions. Every client that was connected now holds an id the new process has never seen.
2. **Several instances behind a load balancer without sticky routing.** The instance that answered `initialize` holds the session. A later request that lands on another instance gets 404. With round-robin balancing, some requests work and others fail with no pattern you can see.
3. **The session expired.** Servers close idle sessions after a timeout. A client that was quiet for a long time, or was suspended (a laptop lid closed), comes back with an expired id.
4. **The server evicted the session.** Servers with a cap on open sessions close the least recently used one when the cap is reached.
5. **The client reused a stored id.** A client that saves the session id and reuses it after its own restart, or shares one id between several connections, sends an id the server may have ended long ago.
6. **The session belongs to someone else.** Some servers bind a session to the credentials or the endpoint that opened it and answer 404 when another token or path uses it.

Two look-alikes are not session problems:

- **404 on `initialize` itself.** No session exists yet, so the URL is wrong (for example `/sse` instead of `/mcp`), or the server is an old HTTP+SSE server. Check the endpoint path.
- **`400 Bad Request` asking for a session id.** The client sent no `Mcp-Session-Id` at all. A proxy may be dropping the header on the way in, or not passing it back on the `initialize` response.

## How to check

Reproduce the exchange by hand with curl. Replace the URL with your server's endpoint and add an `Authorization` header if it needs one.

```bash
# 1. Open a session and print the session id header
curl -si https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"debug","version":"0"}}}' \
  | grep -i '^mcp-session-id'

# 2. Finish the handshake, then use the session (paste the value from step 1)
SID='<id from step 1>'
curl -si https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -si https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Then narrow it down:

- **Repeat the `tools/list` call several times.** If some calls work and some return 404, requests are spread across instances that do not share sessions.
- **Restart the server and repeat the `tools/list` call.** A 404 now, with a fresh `initialize` working, confirms sessions live in process memory.
- **Wait past the idle timeout** the server documents, then repeat the `tools/list` call.
- **No `mcp-session-id` line in step 1?** The server runs without sessions, or a proxy strips the header. Call the server directly, bypassing the proxy, and compare.
- **Read the body of the 404.** A JSON-RPC error saying the session ended is the session case. An HTML page or an empty body usually means a proxy or the wrong path answered.

## Fix

**On the client.** Treat `404` on a request that carried a session id as "start again": forget the id, send `initialize`, then retry the request on the new session. A server that follows the specification answers 404 instead of processing the request, so sending it once more on the new session should not run it twice; for a write tool behind a proxy you do not control, check before resending. If your client does not do this by itself, as some clients do not, reconnecting the server in the client's settings or restarting the client opens a new session. Do not persist session ids across client restarts.

**On the server, for scale-out.** Either share session state between instances (a database or cache all of them read), or route each session to the instance that created it. The session id is random and chosen by the instance that answers `initialize`, so hashing the request header does not help: the balancer has to learn the id from the `initialize` response. Keep the sticky entry alive at least as long as the server's idle timeout.

**On the server, for restarts.** Keep sessions in shared storage so they survive a restart, or accept that a deploy ends every session and make sure clients re-initialize.

**Move to a stateless revision.** Under 2026-07-28 there is no session to lose: any instance can answer any request, and state that must span calls travels as an ordinary tool argument the server minted. If both your client and server can speak 2026-07-28, this removes the problem instead of working around it. [Unsupported protocol version](/learn/troubleshooting/mcp-unsupported-protocol-version) covers how the two sides agree on a revision.

## If you run agents in L2M

**L2M calling your servers.** With a session-based server, the `http_mcp` adapter opens a session with `initialize` and reuses it within a workflow run. A session is replaced after five minutes. When a tool call fails, including with a 404, L2M opens a new session and sends the call once more. It does not do that when the outcome is unknown (the connection broke after the request was sent, or a timeout on a tool that is not read-only or idempotent; see the [safe re-send rule](/product/mcp-2026-07-28#the-safe-re-send-rule)), or after a `403 insufficient_scope`. Discovering a server's tools always opens a new session. If the second attempt fails too, the call fails with the server's answer, such as `MCP HTTP 404: ...`, and the agent sees that error as the tool result. L2M does not send `DELETE` at the end of a run; the server's idle timeout ends the session. A server that L2M talks to in 2026-07-28 (see [protocol modes](/product/mcp-2026-07-28#protocol-modes)) has no session to lose.

**L2M serving clients through the gateway.** The [MCP gateway](/product/mcp-gateway) keeps each session in the memory of the instance that opened it. A request with an unknown id, or one opened by another gateway client or for another toolset, gets `404` with the message "Session not found; it ended or expired. Initialize a new session." A request without the header gets `400`: "Mcp-Session-Id header is required; send initialize first." Sessions end:

- after `MCP_GATEWAY_SESSION_IDLE_MS` without a request (30 minutes by default);
- when `MCP_GATEWAY_MAX_SESSIONS` (500 by default) is reached, which closes the least recently used idle session;
- when the client is revoked or the toolset is removed;
- when the instance shuts down, so a restart ends every session on it.

In a cluster, route by session id as described in [MCP gateway sessions](/operations/cluster#mcp-gateway-sessions), or set `MCP_GATEWAY_MODERN_PROTOCOL=on` so clients that speak 2026-07-28 call without a session and need no stickiness ([clients without sessions](/operations/cluster#clients-without-sessions-mcp-2026-07-28)).

Related errors: [Request timed out](/learn/troubleshooting/mcp-request-timed-out) for calls that got no answer at all, [MCP error -32000: Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed) for the stdio equivalent of a server going away, and [403 insufficient_scope](/learn/troubleshooting/mcp-403-insufficient-scope) for a refusal that a new session will not fix.

## Further reading

- [MCP specification, 2025-11-25: Transports, session management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- In L2M: [MCP gateway sessions in a cluster](/operations/cluster#mcp-gateway-sessions), [MCP 2026-07-28 support](/product/mcp-2026-07-28), [MCP gateway: the endpoint](/product/mcp-gateway#the-endpoint)
