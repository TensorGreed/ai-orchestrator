---
title: "Resource indicators (RFC 8707) for MCP tokens"
term: "Resource indicator"
topic: security
definition: "The OAuth `resource` parameter (RFC 8707), which names the API a token is for, so the authorization server can limit the token's audience to that one API."
description: "A resource indicator names the server a token is for, so a token for one MCP server cannot be replayed against another. RFC 8707 and the MCP rule."
related: [protected-resource-metadata, token-passthrough, confused-deputy, pkce, oauth-2-1]
guide: [/learn/mcp/authorization]
---

# Resource indicator

**The OAuth `resource` parameter (RFC 8707), which names the API a token is for, so the authorization server can limit the token's audience to that one API.**

Plain OAuth says what a token may do (scopes) but not where it may be used. If one authorization server protects several APIs, a token issued for one of them may be accepted by all of them. Then any API that receives a token, or any place a token leaks from, can replay it against the others.

RFC 8707 lets the client say where the token will go. The value of `resource` "MUST be an absolute URI", must not have a fragment, and should not have a query. A client may send several. The authorization server "SHOULD audience-restrict issued access tokens" to the named resources, and answers `invalid_target` for a resource it does not know. An audience-restricted token, in the RFC's words, "cannot then be taken by that resource and presented elsewhere".

## The MCP rule

MCP makes the parameter mandatory for clients. The `resource` value:

- goes in both the authorization request and the token request;
- is the canonical URI of the MCP server: lowercase scheme and host, no fragment, and usually no trailing slash, such as `https://mcp.example.com/mcp`;
- is sent even when the authorization server ignores it.

On the other end, an MCP server must reject any token that was not issued for it.

## Example

```text
GET /authorize?response_type=code&client_id=...&resource=https%3A%2F%2Fmcp.example.com%2Fmcp&...
POST /token  grant_type=authorization_code&code=...&resource=https%3A%2F%2Fmcp.example.com%2Fmcp
```

When the authorization server supports the parameter, the token that comes back carries `https://mcp.example.com/mcp` as its audience. A second MCP server that checks the audience refuses it.

## Common confusion

- **It is not a scope.** `files:read` says what; `resource` says where. A token needs both to be narrow.
- **Sending it does not protect anyone by itself.** The authorization server must honour it, and the receiving server must check the audience. A server that skips the check, or that forwards the token downstream (<Term id="token-passthrough">token passthrough</Term>), undoes the protection.
- **The value comes from the server.** The `resource` field of the server's <Term id="protected-resource-metadata">protected resource metadata</Term> is the identifier a client should use.

## In L2M

L2M sends `resource` on the authorization request, the token request and every refresh ([OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers)). It uses the `resource` from the server's protected resource metadata, after checking that it is identical to the server's URL, as RFC 9728 requires; a document with no `resource` is refused. The [MCP gateway](/product/mcp-gateway#clients) does not take OAuth tokens from its clients, and calls upstream servers with the registry's own credentials, never a client's token.

## Further reading

- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html) (IETF)
- [MCP specification 2026-07-28: authorization, resource parameter](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) (modelcontextprotocol.io)
