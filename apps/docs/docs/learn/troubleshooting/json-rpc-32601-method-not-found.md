---
title: "MCP error -32601 Method not found: causes and fixes"
sidebarTitle: "-32601 Method not found"
description: "Why an MCP server or client answers -32601 Method not found: a typo, a capability it never offered or a revision mismatch, and how to check."
level: intermediate
about: model-context-protocol
related: [model-context-protocol, mcp-server, mcp-client, mcp-resource, mcp-prompt, streamable-http]
---

# MCP error -32601: Method not found

`-32601 Method not found` means the side that received a JSON-RPC request has no handler for its `method`. In MCP that is rarely a broken server: usually the method name is misspelled, the server never offered that feature, or the two sides speak different protocol revisions.

## What it means

JSON-RPC 2.0 defines `-32601` as "The method does not exist / is not available." The request reached the other side and was parsed, so the transport works; only the method name was not recognised. That separates it from its neighbours:

- `-32700` and `-32600`: the message itself was broken.
- `-32601`: the message was fine, the **method** is unknown.
- `-32602`: the method is known, the **parameters** are wrong. An unknown *tool* name is a parameter of `tools/call`, so it gives `-32602`, not `-32601` (see [-32602 Invalid params](/learn/troubleshooting/json-rpc-32602-invalid-params)).

In MCP, which methods exist depends on what each side declared. In the session-based revisions (2025-11-25 and earlier) client and server exchange **capabilities** in the `initialize` handshake. A server that offers tools declares `tools`; one that offers <Term id="mcp-resource">resources</Term> declares `resources`; <Term id="mcp-prompt">prompts</Term>, logging and completions work the same way. After the handshake both sides MUST only use capabilities that were negotiated. Calling `resources/list` on a server that declared only `tools` breaks that rule, and `-32601` is the natural answer.

The error also travels the other way. A server can send requests to the client (`sampling/createMessage`, `elicitation/create`, `roots/list`). A client that does not support one of them answers `-32601` to the server.

In 2026-07-28 there is no handshake. Capabilities come from `server/discover`, which every 2026-07-28 server MUST implement, and over <Term id="streamable-http">Streamable HTTP</Term> a server that does not implement a method MUST answer `404 Not Found` with a `-32601` body. The JSON-RPC body is what tells this apart from a plain 404 for a wrong URL.

## Causes (most to least likely)

1. **The server does not offer that feature.** Many servers provide only tools. A client or inspector that asks for `resources/list`, `prompts/list`, `logging/setLevel` or `completion/complete` gets `-32601`. If tools still work, an error like this in a log is harmless.
2. **A typo in the method name.** Method names are case-sensitive and plural where the specification says so: `tools/call`, not `tool/call` or `tools/Call`; `resources/read`, not `resource/read`. This bites hand-written clients, scripts and test harnesses.
3. **The two sides speak different revisions.** A 2026-07-28 client that sends `server/discover` to a session-based server usually gets `-32601`: the method did not exist before 2026-07-28. (The specification leaves the legacy server's answer open; some return another error or none at all.) That is the normal signal that the server is older, and a client that speaks both revisions falls back to `initialize`. The reverse also happens: `initialize` sent to a server that speaks only 2026-07-28 is an unknown method there. Methods that 2026-07-28 removed, such as `ping` and `logging/setLevel`, may be unknown to a server that speaks only that revision.
4. **The server asked the client for something it does not support.** A server that sends `roots/list` or `sampling/createMessage` to a client without that capability gets `-32601` back. If the server treats that as fatal, the tool call fails.
5. **A proxy or gateway in between serves only part of MCP.** A gateway that forwards tools only answers `-32601` for resources and prompts, even when the server behind it has them.

## How to check

**See what the server declares.** For a session-based <Term id="mcp-server">MCP server</Term> on stdio, send `initialize` and look at `capabilities`, then try the method you need. This uses the echo server in the L2M repository (`samples/mcp-echo-server`), which offers tools only:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"debug","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"resources/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tool/call","params":{"name":"echo","arguments":{"message":"hi"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"}}}' \
  | node samples/mcp-echo-server/server.mjs
```

```text
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"l2m-echo","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found: resources/list"}}
{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found: tool/call"}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"hi"}]}}
```

The capabilities say `tools` only, so `resources/list` is refused; `tool/call` is a typo; `tools/call` works.

**Probe the revision.** Send a 2026-07-28 `server/discover` to the same server:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
  | node samples/mcp-echo-server/server.mjs
```

```text
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: server/discover"}}
```

A `-32601` here means a session-based server: use `initialize`. A result with `supportedVersions` means a 2026-07-28 server. For a remote server, send the same JSON with curl and read both the HTTP status and the body.

**Find out who said it.** Check whether the error is in the server's response to your request, or in your client's response to a request from the server. The method name in the message (`roots/list`, `sampling/createMessage`) usually gives it away.

## Fix

- **Only call what was declared.** Read `capabilities` from `initialize` (or `server/discover`) and skip features the server does not offer. If you need resources or prompts, use a server that provides them or add them to your own server.
- **Correct the method name** to the exact string in the specification.
- **Match revisions.** Configure the client for the revision the server speaks, or use a client that speaks both and falls back. [Unsupported protocol version](/learn/troubleshooting/mcp-unsupported-protocol-version) explains how the two sides agree.
- **For server-to-client requests,** check the client's declared capabilities before sending `roots/list`, `sampling/createMessage` or `elicitation/create`, and handle a refusal as a normal outcome rather than failing the tool.
- **Behind a gateway,** check which methods it forwards; call the server directly if you need what it filters out.

## If you run agents in L2M

- **Probes follow the capabilities.** A registry probe connects and lists the server's tools, and lists resources, resource templates and prompts only when the server declares `resources` or `prompts`. Errors from those optional lists are ignored, so a tools-only server is not marked down for them. The [Playground](/product/mcp-onboarding#playground) shows a panel per capability, which is a quick way to see what a server offers.
- **Revisions.** With a server set to Auto, L2M sends `server/discover` first. A `-32601` answered with HTTP 200 marks the server as session-based, and L2M falls back to `initialize`; a `404` with a `-32601` body marks it as a 2026-07-28 server that lacks that one method. See [protocol modes](/product/mcp-2026-07-28#protocol-modes).
- **Requests L2M refuses.** On a session, L2M answers `ping`, `elicitation/create` and, when a model is attached to the call, `sampling/createMessage` (without a model, sampling is refused with `-32001`, not `-32601`). Anything else, such as `roots/list`, gets `-32601` with `Method not supported by this client: <method>`. L2M declares no roots capability.
- **Health.** A `-32601` from a server during a tool call is recorded as a protocol failure, which counts toward the [circuit breaker](/product/mcp-server-registry#rate-limits-concurrency-and-the-circuit-breaker), unlike `-32602`.
- **The gateway serves tools only.** On the [MCP gateway](/product/mcp-gateway), `resources/*`, `prompts/*`, `completion/complete` and `logging/setLevel` get `-32601` (see [known gaps](/product/mcp-2026-07-28#known-gaps)). With `MCP_GATEWAY_MODERN_PROTOCOL=on`, a 2026-07-28 request for `initialize` or any other method the gateway does not serve gets HTTP 404 with `-32601`.

If the server connects but the agent still has nothing to call, see [MCP server connected but no tools show up](/learn/troubleshooting/mcp-server-shows-no-tools).

## Further reading

- [JSON-RPC 2.0 Specification, section 5.1: Error object](https://www.jsonrpc.org/specification) (jsonrpc.org)
- [MCP specification, 2025-11-25: Lifecycle, capability negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) (modelcontextprotocol.io)
- In L2M: [MCP onboarding and Playground](/product/mcp-onboarding#playground), [Resources and prompts](/product/mcp-server-registry#resources-and-prompts), [MCP 2026-07-28 support](/product/mcp-2026-07-28)
