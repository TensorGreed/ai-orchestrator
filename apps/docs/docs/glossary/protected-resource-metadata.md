---
title: "Protected resource metadata (RFC 9728)"
term: "Protected resource metadata"
topic: security
definition: "A JSON document, defined in RFC 9728, that a protected API such as a remote MCP server publishes to say which authorization servers issue its tokens and which scopes it uses."
description: "The document an MCP server publishes to name the authorization servers it trusts and the scopes it uses, so a client can find where to sign in."
related: [resource-indicator, dynamic-client-registration, pkce, oauth-2-1, streamable-http]
guide: [/learn/mcp/authorization]
---

# Protected resource metadata

**A JSON document, defined in RFC 9728, that a protected API such as a remote MCP server publishes to say which authorization servers issue its tokens and which scopes it uses.**

A client that meets a protected API for the first time has a question OAuth alone does not answer: where do I get a token for this? RFC 9728 answers it from the API's side. The API, the resource server, serves a small document that names its authorization servers; the client then reads each authorization server's own metadata (RFC 8414 or OpenID Connect discovery) to find the endpoints.

The main fields:

- `resource` (required): the API's identifier, an `https` URL without a fragment.
- `authorization_servers`: issuer URLs of the authorization servers it accepts tokens from. MCP requires at least one.
- `scopes_supported` (recommended): the scopes a client may ask for.
- `bearer_methods_supported`, `jwks_uri`, `resource_name`: optional details.

There are two ways to find the document. The server can name it in the `resource_metadata` parameter of a `WWW-Authenticate` challenge, usually on a `401`. Or the client builds the well-known URL by putting `/.well-known/oauth-protected-resource` between the host and the path.

## Example

For an MCP server at `https://mcp.example.com/mcp`, the well-known URL is `https://mcp.example.com/.well-known/oauth-protected-resource/mcp`:

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["files:read"],
  "bearer_methods_supported": ["header"]
}
```

## Common confusion

This is not the authorization server's metadata. Protected resource metadata describes the API and points to the authorization server; authorization server metadata (RFC 8414) describes the endpoints, PKCE support and registration options. A client needs both.

Its `resource` value is also a check, not decoration. RFC 9728 says it "MUST be identical" to the identifier the client used to build the URL, otherwise the document must not be used, so one server cannot pass off another's metadata. The same value is what a client sends as its <Term id="resource-indicator">resource indicator</Term>.

## In L2M

As a client, L2M reads the `resource_metadata` URL from the server's `401`, or else tries the path-specific well-known URL and then the root one. It refuses a document with no `authorization_servers`, a URL that is not `https` (loopback excepted), or a document whose `resource` is missing or is neither the server's URL nor a parent path of it on the same origin (the one exception to an exact match, which the reference MCP TypeScript SDK client also makes), and it uses the first authorization server listed ([OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers)). The [MCP gateway](/product/mcp-gateway#clients) does not publish this document: its clients use per-client bearer tokens created in the studio, not OAuth. When discovery breaks at the next step, see ["Failed to fetch authorization server metadata"](/learn/troubleshooting/failed-to-fetch-authorization-server-metadata).

## Further reading

- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) (IETF)
- [MCP specification 2026-07-28: authorization server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery) (modelcontextprotocol.io)
