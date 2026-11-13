---
title: "Token passthrough: an MCP anti-pattern"
term: "Token passthrough"
topic: security
definition: "An anti-pattern in which an MCP server accepts an access token that was not issued for it and forwards that token to a downstream API; the MCP specification forbids it."
description: "Token passthrough is an MCP server accepting a token not issued for it and forwarding it downstream. The spec forbids it; here is why."
related: [confused-deputy, oauth-2-1, delegated-credentials, mcp-gateway]
guide: [/learn/mcp/authorization]
---

# Token passthrough

**An anti-pattern in which an MCP server accepts an access token that was not issued for it and forwards that token to a downstream API; the MCP specification forbids it.**

It is tempting when you wrap an existing API. The client already has a token for the API, so the MCP server just copies the `Authorization` header onward and skips running its own OAuth. The MCP authorization spec says no, twice: servers "MUST NOT accept or transit any other tokens", and when a server calls upstream APIs, the upstream token "is a separate token, issued by the upstream authorization server. The MCP server MUST NOT pass through the token it received from the MCP client."

The security best practices give the reasons:

- **Controls are skipped.** Rate limits, validation and monitoring that depend on the token's audience no longer apply.
- **Nobody can tell who called.** The MCP server cannot tell its clients apart, and the downstream logs show a different identity from the one actually acting.
- **A stolen token goes further.** If several services accept the same token, compromising one opens the others, and the MCP server becomes a proxy for exfiltration.

The fix is audience binding. The client asks for a token for this MCP server (the RFC 8707 `resource` parameter), the server checks that it is the intended audience, and any upstream call uses a second token issued for that upstream.

## Example

A client sends `Authorization: Bearer <token for api.tracker.example>` to `mcp.tracker.example`. A passthrough server forwards it as is. A correct server rejects it with 401, because the token's audience is the API, not the MCP server.

## Common confusion

Passing the user's identity downstream is fine; passing the user's token is not. A server can act for the user with its own token, issued for the upstream and tied to that user. OWASP's cheat sheet adds the client-side twin: "Use scoped, per-server credentials — never share tokens across servers."

## In L2M

[MCP gateway](/product/mcp-gateway#clients) client tokens are minted by L2M, stored hashed, scoped to <Term id="toolset">toolsets</Term>, and never sent upstream. Calls to a registered server use that server's own secret or OAuth connection, or, with [delegated credentials](/product/mcp-server-registry#delegated-credentials), the user's own connection to that server.

## Further reading

- [MCP specification 2025-11-25: authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io)
- [MCP security best practices: token passthrough](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) (modelcontextprotocol.io)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org)
