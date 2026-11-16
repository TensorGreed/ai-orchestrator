---
title: "Dynamic client registration (DCR) in OAuth and MCP"
term: "Dynamic client registration"
topic: security
definition: "An OAuth extension (RFC 7591) that lets an application register itself with an authorization server at runtime, by posting its metadata to a registration endpoint and getting a client id back."
description: "DCR lets an app register itself with an authorization server at runtime. Why MCP clients used it, its risks, and the client ID metadata alternative."
related: [oauth-2-1, pkce, protected-resource-metadata, confused-deputy, mcp-client]
guide: [/learn/mcp/authorization]
---

# Dynamic client registration

**An OAuth extension (RFC 7591) that lets an application register itself with an authorization server at runtime, by posting its metadata to a registration endpoint and getting a client id back.**

OAuth assumes the client is known before it asks for a token: someone registered it, typed in a redirect URI and got a client id. That breaks down for an <Term id="mcp-client">MCP client</Term>, which may be pointed at a server, and so at an authorization server, nobody has seen before. Dynamic client registration (DCR) removes the manual step. The authorization server lists a `registration_endpoint` in its metadata, and the client posts its name, redirect URIs and grant types there.

RFC 7591 allows two modes. With **open registration**, anyone may register, no credentials needed. With an **initial access token**, only parties given that token can register, which RFC 7591 says is required "when the authorization server limits the parties that can register a client".

## Example

```http
POST /register HTTP/1.1
Content-Type: application/json

{"client_name":"Example agent","redirect_uris":["https://agent.example.com/callback"],
 "grant_types":["authorization_code","refresh_token"],"token_endpoint_auth_method":"none"}
```

The answer carries a `client_id`, and a `client_secret` with `client_secret_expires_at` for a confidential client.

## Risks

- **Everything is self-asserted.** Unless it comes in a signed software statement, the authorization server "MUST treat all client metadata as self-asserted". A rogue client can register with another app's name and logo, so a consent screen that shows `client_name` proves little.
- **URLs in the metadata** (a policy or logo link) can point anywhere, and open registration lets anyone supply them.
- **Clutter.** Clients that register again on every start leave unused client ids behind at the authorization server.
- **Proxies.** An MCP proxy that registers clients dynamically and then uses one static client id upstream is the setting for the <Term id="confused-deputy">confused deputy</Term> attack.

## Common confusion

DCR is not the only way to get a client id. MCP lists three: pre-registration, Client ID Metadata Documents (CIMD) and DCR. With CIMD the client id is an `https` URL pointing at a JSON document the client hosts; the authorization server fetches it and checks that its `client_id` matches the URL. The 2026-07-28 revision deprecates DCR in favour of CIMD and keeps it only for authorization servers that do not support those documents yet.

## In L2M

When you leave the client id empty on an [OAuth server](/product/mcp-server-registry#oauth-for-remote-servers), L2M asks to register as a public client (no secret, PKCE), with `application_type` `native` for a loopback redirect URL and `web` otherwise, and reuses that registration only with the authorization server that issued it. With `MCP_OAUTH_CLIENT_METADATA_ENABLED=true` (off by default) and a public `https` base URL, it offers a [client metadata document](/product/mcp-server-registry#client-metadata-document) first to authorization servers that support it. A client id you enter always wins.

## Further reading

- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://www.rfc-editor.org/rfc/rfc7591.html) (IETF)
- [MCP specification 2026-07-28: client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) (modelcontextprotocol.io)
- [MCP 2026-07-28: deprecated features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) (modelcontextprotocol.io)
