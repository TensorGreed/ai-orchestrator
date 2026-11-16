---
title: "MCP unsupported protocol version (-32022) explained"
sidebarTitle: "Unsupported protocol version"
description: "What happens when an MCP client and server speak different protocol revisions: the -32020 to -32022 errors of 2026-07-28, older 400 answers, and fixes."
level: intermediate
about: model-context-protocol
related: [model-context-protocol, mcp-client, mcp-server, streamable-http, stdio-transport]
---

# MCP "Unsupported protocol version" (-32022)

An "unsupported protocol version" error means the client asked for an MCP revision the server does not implement. The fix is to let the two sides agree on a revision both speak: retry with a version from the server's `supported` list, or configure the client for the server's revision.

## What it means

<Term id="model-context-protocol">MCP</Term> is versioned by date. The current revision is **2026-07-28**; the most recent ones before it are 2025-11-25, 2025-06-18 and 2025-03-26. The specification calls the ones up to 2025-11-25 **legacy** (they open with an `initialize` handshake) and 2026-07-28 **modern** (no handshake; every request carries its version). How a version mismatch shows up depends on which kind each side is.

**Legacy negotiation.** The client sends the version it wants in `initialize`. If the server supports it, it answers with the same version; otherwise it answers with another version it supports, and a client that does not support that one SHOULD disconnect. Over HTTP, the client then sends `MCP-Protocol-Version` on every request, and a server that gets an invalid or unsupported value MUST answer `400 Bad Request`. Servers may also refuse `initialize` outright; the 2025-11-25 lifecycle page shows an error with code `-32602`, the message "Unsupported protocol version" and `data` listing the `supported` and `requested` versions.

**Modern negotiation.** In 2026-07-28 every request carries `io.modelcontextprotocol/protocolVersion` in `_meta`, and over HTTP also the `MCP-Protocol-Version` header. A server that does not implement the requested version MUST answer with an `UnsupportedProtocolVersionError`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32022,
    "message": "Unsupported protocol version",
    "data": { "supported": ["2026-07-28", "2025-11-25"], "requested": "1900-01-01" }
  }
}
```

The client SHOULD pick a version from `supported` and retry, or report that there is none. Over HTTP the status is `400`. The other errors from the same per-request checks also use `400`:

| Code | Name | Meaning |
|---|---|---|
| `-32020` | HeaderMismatch | The HTTP headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`) are missing or do not match the body. |
| `-32021` | MissingRequiredClientCapability | The request needs a client capability that `_meta` did not declare; `data.requiredCapabilities` names it. |
| `-32022` | UnsupportedProtocolVersion | The server does not speak the requested version; `data.supported` lists what it does. |
| `-32602` | Invalid params | A required `_meta` field, such as the protocol version itself, is missing. |

2026-07-28 reserves `-32020` to `-32099` for codes the specification defines and treats `-32000` to `-32019` as legacy codes with no fixed meaning. Drafts of the revision used `-32001`, `-32003` and `-32004` for these three errors before they were renumbered, so a server built against a draft may still send the old numbers. `-32002` is not a version error: it was "resource not found" before 2026-07-28.

**Mixing eras.** The specification's compatibility matrix is blunt. A client that speaks only 2026-07-28 cannot use a legacy-only server, and a legacy-only client cannot use a server that speaks only 2026-07-28: the server rejects `initialize` (over HTTP with `400`, because the modern headers are missing). Everything works when at least one side speaks both. A dual-era <Term id="mcp-client">MCP client</Term> detects the server's era: over <Term id="streamable-http">Streamable HTTP</Term> it sends a modern request first and falls back to `initialize` on a `400` whose body is not a recognised modern error; over <Term id="stdio-transport">stdio</Term> it probes with `server/discover` and falls back on any other error.

## Causes (most to least likely)

1. **One side was upgraded.** A client moved to 2026-07-28 and the server did not, or the other way round, and neither speaks both.
2. **The client sends a version the server never listed.** A pinned or hard-coded version string, often an old one, or a newer one than the server knows.
3. **The header and the body disagree.** The client sets `MCP-Protocol-Version` from one place and `_meta` from another, or a proxy rewrites or drops the header. That is `-32020`, not `-32022`.
4. **Nothing in common.** The server's `supported` list and the client's versions do not overlap at all.
5. **A missing capability, not a version.** `-32021` looks similar in a log but names a capability, such as sampling, that the request did not declare.

## How to check

**Ask the server what it supports.** A 2026-07-28 server answers `server/discover` with `supportedVersions`. Replace the URL, and add an `Authorization` header if the server needs one:

```bash
curl -s https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

- A result with `supportedVersions`: a 2026-07-28 server; compare the list with your client.
- `400` with a JSON-RPC error of `-32020`, `-32021` or `-32022`: a 2026-07-28 server; read the code and `data`.
- Any other `400`, `404` or `405` without such a body: a legacy server. Send `initialize` with the version your client wants and read `protocolVersion` in the result.

For a stdio server, pipe the same JSON-RPC line into the server's command. A legacy server usually answers `server/discover` with `-32601` (any error that is not a 2026-07-28 error, or no answer, also means legacy); the repository's echo server shows it:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
  | node samples/mcp-echo-server/server.mjs
```

```text
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: server/discover"}}
```

**Check the headers that leave the client.** Log the outgoing request, or put a plain HTTP echo service in its place, and confirm that `MCP-Protocol-Version` matches the version in `_meta`. If they match at the client but not at the server, a proxy changed them.

## Fix

- **Pick a mutual version.** Retry with a version from `data.supported`. If it lists only legacy versions, open the connection with `initialize`.
- **Use a dual-era client or server** while the ecosystem moves. Either side speaking both revisions is enough.
- **Unpin old versions** in client configuration, or pin to one the server lists.
- **Pass the headers through.** Proxies in front of a 2026-07-28 server must forward `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` unchanged.
- **Declare the capability** for `-32021`, or call the tool from a context that has it (for sampling, one with a model attached).

## If you run agents in L2M

**L2M calling your servers.** Each registered server has a [protocol mode](/product/mcp-2026-07-28#protocol-modes); servers without one use `MCP_CLIENT_PROTOCOL_DEFAULT` (`legacy` unless you change it).

- **Legacy** (the default) opens with `initialize`, offering `2025-06-18`, and uses whatever version the server answers with. If the server rejects `initialize` with a 2026-07-28 error, L2M switches that server to 2026-07-28 and retries, so 2026-07-28-only servers are still reached.
- **Auto** sends `server/discover` first and falls back to `initialize` for legacy servers. The answer is remembered per endpoint (or per stdio command) for an hour. `MCP_CLIENT_ERA_PROBE_TIMEOUT_MS` (5000 by default) is how long it waits. A stdio server that starts too slowly to answer in time is remembered as legacy for that hour, which still works; over HTTP a probe that times out is not remembered.
- **2026-07-28 only** never falls back. A legacy server fails with a message that it "does not speak MCP 2026-07-28" and says to set its protocol to Legacy or Auto.

On `-32022` from a 2026-07-28 server, L2M picks a version both sides support, once. When there is none, the call fails with `MCP server '<name>' supports protocol versions ..., and this client speaks 2026-07-28 or the initialize-based versions.` A `-32021` fails the call as a tool error naming the capability. A `-32020` on a tool call makes L2M list the tools again and retry once. A `protocolMode` other than `legacy`, `auto` or `modern` is refused when the server is saved.

**L2M serving clients through the gateway.** The [MCP gateway](/product/mcp-gateway) speaks `2025-11-25`, `2025-06-18` and `2025-03-26` after `initialize`. An `initialize` asking for another version gets `2025-11-25` back. A request whose `MCP-Protocol-Version` header names a version outside that list gets `400` with `-32000` and `Unsupported MCP-Protocol-Version '<version>'. Supported: 2025-11-25, 2025-06-18, 2025-03-26.` 2026-07-28 clients are served only with `MCP_GATEWAY_MODERN_PROTOCOL=on`. While it is off (the default) they get that legacy answer, which a dual-era client reads as "legacy server" and falls back to `initialize`; a client that speaks only 2026-07-28 cannot connect. With it on, the gateway checks each 2026-07-28 request in order and answers `-32602`, `-32020` or `-32022` (the last listing every version it speaks) as the specification describes. See [how a request is routed](/product/mcp-2026-07-28#how-a-request-is-routed).

Related errors: [Session not found (HTTP 404)](/learn/troubleshooting/mcp-session-not-found-404) for sessions that only legacy revisions have, [-32601 Method not found](/learn/troubleshooting/json-rpc-32601-method-not-found) for the probe answer of a legacy server, and [MCP error -32000: Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed) for a stdio server that exits instead of answering. [MCP transports](/learn/mcp/transports#what-2026-07-28-changes) explains what the 2026-07-28 revision changed.

## Further reading

- [MCP specification, 2026-07-28: Versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Overview, error codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Lifecycle, version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) (modelcontextprotocol.io)
- In L2M: [MCP 2026-07-28 support](/product/mcp-2026-07-28), [Client settings](/product/mcp-2026-07-28#client-settings), [The MCP gateway in modern mode](/product/mcp-2026-07-28#the-mcp-gateway)
