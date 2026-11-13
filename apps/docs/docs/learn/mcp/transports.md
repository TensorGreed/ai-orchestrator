---
title: "MCP transports: stdio vs Streamable HTTP"
sidebarTitle: "MCP transports"
description: "How MCP messages travel: stdio for local servers, Streamable HTTP for remote ones, sessions, Origin checks, and what the stateless 2026-07-28 spec changes."
level: intermediate
about: streamable-http
related: [streamable-http, stdio-transport, mcp-session, mcp-client, mcp-server, mcp-gateway]
---

# MCP transports: stdio vs Streamable HTTP

An MCP transport is the channel that carries a client's and a server's JSON-RPC messages. The specification defines two. With <Term id="stdio-transport">stdio</Term>, the client starts the server as a child process and they exchange one message per line over its standard input and output: use it for a server that runs on the same machine as its client. With <Term id="streamable-http">Streamable HTTP</Term>, the client sends every message as an HTTP POST to one endpoint and the server answers with JSON or a stream of server-sent events: use it for a server that runs somewhere else or serves many clients.

This guide follows the 2025-11-25 specification, which is what most servers speak today, and then explains what the current 2026-07-28 revision changes.

## The two transports at a glance

| | stdio | Streamable HTTP |
|---|---|---|
| Where the server runs | A subprocess the client starts | An independent process, often remote |
| How a message travels | One line on stdin or stdout | One HTTP POST per client message |
| Clients per server | One: the process that started it | Many |
| Server-to-client messages | On stdout | On an SSE stream, if the server opens one |
| Logs | stderr | Not defined by the transport |
| Main risk | The server runs with the client's privileges | It listens on the network |

Both carry the same JSON-RPC 2.0 messages, and the specification says they MUST be UTF-8 encoded. The tools, resources and prompts an <Term id="mcp-server">MCP server</Term> offers do not depend on the transport. Clients and servers may also build custom transports, as long as they keep the JSON-RPC message format and the lifecycle rules.

## stdio: a child process

With stdio, the <Term id="mcp-client">MCP client</Term> launches the server as a subprocess. The server reads JSON-RPC messages from its standard input and writes them to its standard output. Each message is one line, and the specification says messages MUST NOT contain embedded newlines:

```text
→ stdin   {"jsonrpc":"2.0","id":1,"method":"tools/list"}
← stdout  {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read_file", ...}]}}
```

Three rules keep the channel clean:

- The server MUST NOT write anything to stdout that is not a valid MCP message. A stray `print` statement breaks the stream.
- The client MUST NOT write anything else to the server's stdin.
- The server MAY write logs to stderr, and the client SHOULD NOT assume that output on stderr means an error.

When the client is done, it closes the server's stdin and terminates the process. Nothing listens on a network port, so no other program can reach the server. That is why the security best practices suggest stdio for servers meant to run locally: it limits access to just the MCP client.

The cost is that the server is a program running on your machine with the client's permissions. A filesystem server can read whatever the client process can read. [MCP authorization](/learn/mcp/authorization) explains why stdio servers take credentials from their environment instead of using OAuth.

## Streamable HTTP: one endpoint, JSON or SSE

With Streamable HTTP, the server is an independent process that can handle many client connections. It provides a single HTTP endpoint, the MCP endpoint, such as `https://example.com/mcp`, which supports POST and GET.

**Client to server.** Every JSON-RPC message the client sends is a new POST to that endpoint. The body is a single request, notification or response, and the `Accept` header MUST list both `application/json` and `text/event-stream`:

```http
POST /mcp HTTP/1.1
Host: example.com
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-11-25
MCP-Session-Id: 1868a90c...

{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_weather","arguments":{"location":"Leeds"}}}
```

**Server to client.** What comes back depends on what was sent:

- For a notification or a response, the server returns `202 Accepted` with no body.
- For a request, the server either returns one JSON object (`Content-Type: application/json`) or opens an SSE stream (`Content-Type: text/event-stream`). The client MUST handle both.
- On an SSE stream, the server MAY send requests and notifications, such as progress updates, before the response. After the response it SHOULD close the stream.

A dropped connection is not a cancellation. To cancel, the client sends a cancellation notification.

**Listening.** The client MAY send a GET to the endpoint to open a stream the server can use without being asked, for example to say its tool list changed. A server that does not offer one answers `405 Method Not Allowed`.

**The version header.** After the handshake, the client MUST send `MCP-Protocol-Version` on every request. A server that gets no header, and has no other way to tell the version, SHOULD assume `2025-03-26`. A server that gets an invalid or unsupported version MUST answer `400 Bad Request`.

## Sessions in 2025-11-25

In 2025-11-25 a connection starts with an `initialize` handshake that agrees the protocol version and capabilities. A Streamable HTTP server MAY then keep an <Term id="mcp-session">MCP session</Term>:

1. The server puts a session id in an `MCP-Session-Id` header on the response that carries the initialize result. It SHOULD be globally unique and cryptographically secure, and MUST use only visible ASCII characters.
2. The client MUST send that header on every later request. A server that requires it SHOULD answer requests without it (other than initialize) with `400 Bad Request`.
3. The server MAY end the session at any time. After that it MUST answer the old id with `404 Not Found`, and the client MUST start a new session with a new initialize request.
4. A client that is done SHOULD send an HTTP `DELETE` with the header. The server MAY refuse with `405`.

**Resumability.** A server MAY give SSE events ids. After a disconnection, the client SHOULD reconnect with a GET that carries `Last-Event-ID`, and the server MAY replay what the client missed on that stream.

Sessions make a server stateful. If a server keeps its sessions in one process's memory, a load balancer must send each client's requests to the same instance, or the client gets `404` and has to start again.

## The old HTTP+SSE transport

Before Streamable HTTP, protocol version 2024-11-05 defined an HTTP+SSE transport with two endpoints: a GET endpoint that opened an SSE stream, and a separate POST endpoint for client messages. Streamable HTTP replaced it. The 2026-07-28 revision formally lists it as Deprecated, to be removed under the specification's lifecycle policy, and says to migrate to Streamable HTTP.

If a server's docs mention an `/sse` endpoint, that is the old style. The specification describes how a client can support both: POST an initialize request to the URL; if that fails with `400`, `404` or `405`, send a GET and expect an `endpoint` event as the first event, which means the server uses the old transport.

## What 2026-07-28 changes

The 2026-07-28 revision makes MCP stateless. For transports, that means:

- **No handshake.** The `initialize` and `notifications/initialized` exchange is gone. Every request carries its own protocol version and client capabilities in `_meta`.
- **No sessions.** `Mcp-Session-Id` is removed. A server that needs state across calls mints its own handle, such as a cart id, and receives it back as an ordinary tool argument.
- **`server/discover`.** Servers MUST implement it to advertise their versions, capabilities and identity. Clients MAY call it first, and can use it on stdio as a probe for older servers.
- **`subscriptions/listen`.** The GET stream and resource subscriptions are replaced by one long-lived POST stream, where the client opts in to the change notifications it wants.
- **No resumability.** `Last-Event-ID` and SSE event ids are removed. A broken response stream loses the request, and the client MUST send it again as a new request with a new id.
- **Standard headers.** Streamable HTTP POST requests must carry `Mcp-Method` and `Mcp-Name` headers.

stdio stays. The revision also suggests that servers log to stderr on stdio, as the Logging feature is deprecated. The practical gain for HTTP is that with no session to find, any instance behind a load balancer can answer any request.

## Security notes

The transports page puts a security warning on Streamable HTTP. Servers:

- MUST check the `Origin` header on every incoming connection, and answer `403 Forbidden` when it is present and invalid. Without that check, a web page can use DNS rebinding to reach a server on your machine through your browser.
- SHOULD bind only to `127.0.0.1` when running locally, not to every interface (`0.0.0.0`).
- SHOULD authenticate every connection.

Some further rules from the MCP security best practices:

- **A session id is not a credential.** The client must handle it securely. For 2026-07-28 state handles, servers MUST NOT treat possession of a handle as authentication, and SHOULD bind each handle to the authenticated user.
- **Tokens are checked, never forwarded.** "MCP servers MUST NOT accept any tokens that were not explicitly issued for the MCP server." Forwarding a client's token to a downstream API is <Term id="token-passthrough">token passthrough</Term>, which the specification forbids.
- **Local servers run code.** A client that offers one-click setup of a local server MUST show the exact command and get the person's approval first, and SHOULD run the server in a sandbox with minimal default privileges, such as a container.
- **Local HTTP servers need guarding.** A server meant to run locally over HTTP should require an authorization token, or use a unix domain socket or other restricted IPC.

## What L2M speaks today

L2M is an MCP client toward the servers your agents call, and optionally an MCP server toward other clients through its gateway.

**As a client.** The [MCP server registry](/product/mcp-server-registry) has an adapter for each transport:

- `stdio_mcp` starts the command you configure, with its `args`, `env` and `cwd`, and exchanges one JSON message per line. It keeps the last lines of stderr and shows them in the error if the process exits unexpectedly.
- `http_mcp` speaks Streamable HTTP only. It sends `Accept: application/json, text/event-stream`, reads either kind of response, and sends the negotiated `MCP-Protocol-Version` on later requests. By default it opens each connection with `initialize`, asking for `2025-06-18`. Optionally, `MCP_CLIENT_PROTOCOL_DEFAULT=auto` (try 2026-07-28 first, then fall back) or `modern` (2026-07-28 only), or a server's own `protocolMode`, changes that. It does not speak the old HTTP+SSE transport.

A stdio server runs on the API host with the API's own permissions by default. Optionally, an admin can set a server's **Sandbox** to **Container**. L2M then starts it in a throwaway docker or podman container with a read-only root filesystem, a non-root user, all Linux capabilities dropped, CPU, memory and process limits, and no network unless the admin allows it. `MCP_SANDBOX_REQUIRED=true` refuses every stdio server outside a container. See [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers).

**As a server.** If you publish <Term id="toolset">toolsets</Term> on the [MCP gateway](/product/mcp-gateway), each one is served at `POST /mcp/<toolset>` over Streamable HTTP:

- By default it speaks protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`, and answers an unsupported `MCP-Protocol-Version` with `400`. Optionally, with `MCP_GATEWAY_MODERN_PROTOCOL=on`, it also serves 2026-07-28 clients, which send no session id and need no sticky routing ([clients without sessions](/operations/cluster#clients-without-sessions-mcp-2026-07-28)).
- `initialize` returns an `Mcp-Session-Id`; later requests must send it, and `DELETE` with the header ends the session. Sessions live in the memory of the instance that opened them and close after 30 idle minutes by default, so a cluster needs sticky routing.
- Responses are JSON, or an SSE stream when the request asks for progress and the `Accept` header allows it.
- `GET` returns `405`: the gateway offers no server-initiated stream.
- Requests whose `Origin` is not allowed get `403`. Requests with no `Origin`, as desktop, IDE and CLI clients send, are accepted.
- Each client sends its own bearer token. The gateway calls upstream servers with the registry's credential for each server, never with the client's token.

For local use, bind the API to `127.0.0.1` with `API_HOST`. The [endpoint reference](/product/mcp-gateway#the-endpoint) lists every method and status code. To try the gateway with no API key, the [workflow as an MCP tool recipe](/recipes/workflow-as-mcp-tool) serves a workflow from a toolset.

See also: [MCP security risks](/learn/security/mcp-security-risks), for the attacks these transport rules defend against and what L2M does about each.

## Further reading

- [MCP specification, 2025-11-25: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) (modelcontextprotocol.io)
- In L2M: [MCP gateway: the endpoint](/product/mcp-gateway#the-endpoint), [MCP gateway security](/product/mcp-gateway#security), [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)
