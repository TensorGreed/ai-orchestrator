---
title: "MCP roots: folders a client lets a server see"
term: "MCP roots"
topic: mcp
definition: "A list of folders, as file:// URIs, that an MCP client tells a server it considers relevant, so the server can focus its work there. Roots are guidance, not an access control, and 2026-07-28 deprecates them."
description: "Roots are the folders an MCP client tells a server to work in. What they do, why they enforce nothing, and why servers must still check every path."
related: [mcp-client, mcp-server, least-privilege, elicitation, sampling]
guide: [/learn/mcp/what-is-mcp]
---

# MCP roots

**A list of folders, as file:// URIs, that an MCP client tells a server it considers relevant, so the server can focus its work there. Roots are guidance, not an access control, and 2026-07-28 deprecates them.**

A coding assistant opens a project, and a filesystem or git server needs to know which project. Roots are how the client says so. The client declares the `roots` capability; the server asks with `roots/list`; the client answers with a list of roots, each a `file://` URI with an optional name. In 2025-11-25 the server sends `roots/list` as its own request on the session, and a client that declared `listChanged` sends `notifications/roots/list_changed` when the user switches folders. In 2026-07-28 the server instead returns an `input_required` result that asks for `roots/list`, and the client retries its call with the answer.

Roots are a client feature, like <Term id="elicitation">elicitation</Term> and <Term id="sampling">sampling</Term>: the server asks, and the client answers.

## Example

```json
{"jsonrpc":"2.0","id":1,"result":{"roots":[
  {"uri":"file:///home/ana/repos/frontend","name":"Frontend"},
  {"uri":"file:///home/ana/repos/backend","name":"Backend"}]}}
```

In 2025-11-25, a client without roots support should answer `roots/list` with -32601 (method not found).

## Common confusion

Roots are not a sandbox. The 2026-07-28 text says they are "informational guidance rather than an access-control mechanism" and adds: "The protocol does not enforce that servers stay within roots." A server process can read whatever its operating system lets it read, roots or not. That is why the specification puts duties on both sides: clients must validate root URIs against path traversal and should ask the user before exposing them, and servers should validate every path against the roots they were given. Real confinement comes from the operating system: a container, a separate user, read-only mounts. That is <Term id="least-privilege">least privilege</Term>, applied below the protocol.

The 2026-07-28 revision deprecates roots. It stays in the specification for at least twelve months; the migration path is to pass folders or files as tool parameters, resource URIs or server configuration.

## In L2M

L2M does not declare the `roots` capability. On a 2025-11-25 session it answers a server's `roots/list` with -32601, and on 2026-07-28 a request for roots ends the call with an error. To confine what a local server can touch, run it in a [sandboxed container](/product/mcp-server-registry#sandboxed-stdio-servers): host folders can be mounted only under `MCP_SANDBOX_ALLOWED_MOUNT_ROOTS` (none by default) and are read-only unless marked writable. Pass the folder a tool should use as an argument or in the server's command line.

## Further reading

- [MCP specification 2025-11-25: roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: roots](https://modelcontextprotocol.io/specification/2026-07-28/client/roots) (modelcontextprotocol.io)
- [MCP 2026-07-28: deprecated features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) (modelcontextprotocol.io)
