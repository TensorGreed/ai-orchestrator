---
title: "MCP authorization: OAuth 2.1 for remote MCP servers"
sidebarTitle: "MCP authorization"
description: "How a remote MCP server asks for OAuth: the 401 challenge, resource metadata, PKCE, the resource parameter, and why tokens must never be passed through."
level: intermediate
about: oauth-2-1
related: [oauth-2-1, pkce, token-passthrough, confused-deputy, delegated-credentials]
socialCard: true
---

# MCP authorization: OAuth 2.1 for remote MCP servers

MCP authorization is the part of the Model Context Protocol that lets a remote MCP server demand a token before it answers. It is built on <Term id="oauth-2-1">OAuth 2.1</Term>: the server answers an unauthenticated request with `401`, points the client to metadata that names its authorization server, and the client gets a token for that one server through a browser sign-in with <Term id="pkce">PKCE</Term>. The token is then sent as a bearer token on every request.

This guide follows the flow in the 2025-11-25 specification, the revision before the current one, and notes what the current 2026-07-28 revision changes.

## When MCP needs authorization

Authorization is optional in MCP. The specification says what to do when you use it:

- **HTTP servers** (<Term id="streamable-http">Streamable HTTP</Term>) SHOULD follow the MCP authorization specification.
- **stdio servers** SHOULD NOT. A local server started by the client takes its credentials from the environment, such as an API key in an environment variable.
- **Other transports** must follow the security practices of their own protocol.

So a filesystem server on your laptop needs no OAuth. A hosted server that reads someone's calendar, tickets or repositories usually does, because it acts for a particular person and the client must prove it may.

Three parties take part. The **MCP server** is an OAuth resource server: it accepts tokens. The **MCP client** is an OAuth client: it gets tokens and sends them. The **authorization server** signs the person in, asks for consent and issues tokens. It can be part of the MCP server or a separate identity provider.

## The flow, step by step

<figure class="recipe-diagram">
<svg viewBox="0 0 660 470" role="img" aria-labelledby="mcp-auth-title mcp-auth-desc" xmlns="http://www.w3.org/2000/svg"><title id="mcp-auth-title">The MCP authorization flow</title><desc id="mcp-auth-desc">The client calls the MCP server without a token and gets 401 with a resource_metadata URL. It fetches the protected resource metadata, which names the authorization server, then fetches the authorization server metadata. It registers or uses a known client id, sends the person to the authorization endpoint with PKCE and the resource parameter, receives a code, exchanges it for a token, and calls the MCP server with the bearer token.</desc><defs><marker id="mcp-auth-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><g class="rd-node" data-kind="agent" transform="translate(30 16)"><rect width="150" height="44" rx="10"/><text class="rd-name" x="14" y="27">MCP client</text></g><g class="rd-node" data-kind="tool" transform="translate(255 16)"><rect width="150" height="44" rx="10"/><text class="rd-name" x="14" y="27">MCP server</text></g><g class="rd-node" data-kind="step" transform="translate(480 16)"><rect width="150" height="44" rx="10"/><text class="rd-name" x="14" y="20">Authorization</text><text class="rd-name" x="14" y="36">server</text></g><path class="rd-edge is-port" d="M105 60 L105 460"/><path class="rd-edge is-port" d="M330 60 L330 460"/><path class="rd-edge is-port" d="M555 60 L555 460"/><path class="rd-edge" d="M105 94 L327 94" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="87" text-anchor="middle">1. request, no token</text><path class="rd-edge" d="M330 126 L108 126" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="119" text-anchor="middle">401 + resource_metadata</text><path class="rd-edge" d="M105 166 L327 166" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="159" text-anchor="middle">2. GET resource metadata</text><path class="rd-edge" d="M330 198 L108 198" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="191" text-anchor="middle">authorization_servers</text><path class="rd-edge" d="M105 238 L552 238" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="330" y="231" text-anchor="middle">3. GET authorization server metadata</text><path class="rd-edge is-port" d="M105 278 L552 278" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="330" y="271" text-anchor="middle">4. client id (only dynamic registration calls)</text><path class="rd-edge" d="M105 318 L552 318" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="330" y="311" text-anchor="middle">5. browser sign-in: PKCE + resource + state</text><path class="rd-edge" d="M555 350 L108 350" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="330" y="343" text-anchor="middle">authorization code (to the redirect URI)</text><path class="rd-edge" d="M105 390 L552 390" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="330" y="383" text-anchor="middle">6. code + code_verifier + resource → token</text><path class="rd-edge" d="M105 436 L327 436" marker-end="url(#mcp-auth-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="429" text-anchor="middle">7. Authorization: Bearer …</text></svg>
<figcaption>Every URL the client fetches comes from metadata, so a client can connect to a server it has never seen before.</figcaption>
</figure>

**1. The challenge.** The client calls the server without a token. The server answers `401 Unauthorized` with a `WWW-Authenticate` header. The header carries the `resource_metadata` URL and, ideally, the scope this request needs:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource",
                         scope="files:read"
```

**2. Protected resource metadata.** The client fetches that URL. The document follows RFC 9728 and must list at least one entry in `authorization_servers`. If the header carries no URL, the client tries the well-known paths: first the one built from the MCP endpoint's path, then the root `/.well-known/oauth-protected-resource`.

**3. Authorization server metadata.** The client fetches the authorization server's metadata from the well-known locations of RFC 8414 or OpenID Connect discovery, in the order the specification gives. The metadata names the authorization and token endpoints, and whether the server supports PKCE, client metadata documents or registration.

**4. A client id.** The client needs an identity at that authorization server (see the next section).

**5. Sign-in.** The client opens the person's browser at the authorization endpoint with a PKCE challenge, a `state` value, the scope, and the `resource` parameter naming the MCP server. The person signs in and consents. The authorization server sends the browser back to the client's redirect URI with a code.

**6. Token.** The client exchanges the code, the PKCE verifier and the same `resource` value for an access token, and often a refresh token.

**7. Calls.** Every request to the MCP server now carries `Authorization: Bearer <token>`. The specification forbids putting tokens in the query string.

## Client registration: three ways to get a client id

An OAuth client normally registers with an authorization server in advance. MCP clients often meet servers they have never seen, so the specification allows three ways. A client that supports all of them should try them in this order:

1. **Pre-registration.** You registered the client with the authorization server yourself and typed its client id (and secret, if any) into the client. Use this when the two already know each other, for example inside one company.
2. **Client ID Metadata Documents (CIMD).** The client id is an HTTPS URL that points to a JSON document describing the client: its name and its redirect URIs. The authorization server fetches the document and checks it. Clients use this when the server's metadata says `client_id_metadata_document_supported`.
3. **Dynamic client registration** (RFC 7591). The client posts its details to the server's `registration_endpoint` and gets a client id back.

If none works, the client asks the person to enter the details.

**What 2026-07-28 changes.** The new revision deprecates dynamic client registration in favour of client metadata documents. It stays available for authorization servers that do not support them yet. The revision also adds a check against mix-up attacks: authorization servers should return an `iss` parameter (RFC 9207), and clients must compare a present `iss` with the issuer they expected before redeeming the code. Client credentials are bound to the authorization server that issued them, and must not be reused with another one.

## PKCE and the resource parameter

Two parameters do most of the protecting.

**PKCE** stops a stolen authorization code from being redeemed. The client makes a random secret (the verifier), sends a hash of it (the challenge) with the sign-in request, and sends the verifier itself with the token request. Only the client that started the flow knows the verifier. MCP clients must use PKCE, with the `S256` method when technically capable, and must refuse to continue when the authorization server's metadata has no `code_challenge_methods_supported`. That field is how a client knows PKCE is supported, since OAuth defines no other way to find out.

**The `resource` parameter** (RFC 8707) names the MCP server the token is for, using its canonical URI, such as `https://mcp.example.com/mcp`. It goes in both the authorization request and the token request, and the client must send it even if the authorization server ignores it. When the authorization server supports it, the token's audience is that one server, so other servers that check the audience reject it.

## Audience checks, and no token passthrough

On the server side, the rule is short: an MCP server must check that every token was issued for it, and must reject the rest.

Two mistakes break that rule:

- **No audience check.** A server that accepts any valid token from the identity provider will also accept a token that was issued for a different service. A token stolen from one place now works in another.
- **<Term id="token-passthrough">Token passthrough</Term>.** A server that forwards the client's token to a downstream API, instead of getting its own, is the anti-pattern the specification forbids outright. The downstream API sees a request it cannot attribute, its rate limits can be bypassed and its audit trail can point at the wrong caller, and a stolen token can use the MCP server as a proxy.

If an MCP server calls other APIs, it acts as an OAuth client toward them, with separate tokens from those APIs' authorization servers.

The <Term id="confused-deputy">confused deputy</Term> problem is the related attack on MCP proxy servers. A proxy that uses one static client id at a third-party API, and also lets MCP clients register dynamically, can be tricked into sending an authorization code to an attacker when the third party remembers an earlier consent. The fix in the security best practices is consent per client at the proxy, exact redirect URI matching, and a single-use `state` that is set only after consent.

Authorization is one of several MCP risks. [MCP security risks](/learn/security/mcp-security-risks) covers the others, such as tool poisoning and server-side request forgery, and what L2M does about each.

## Scopes and step-up

Scopes say what a token may do, such as `files:read` or `files:write`. The specification asks for the least privilege that works:

- On first sign-in, a client uses the `scope` from the `401` challenge. Without one, it asks for the scopes in `scopes_supported` from the resource metadata, which should be the minimal set for basic use.
- When an existing token is too weak for a call, the server answers `403 Forbidden` with `error="insufficient_scope"` and the scopes this operation needs. The client then runs the sign-in again with more scopes. This is **step-up authorization**.
- Clients should limit how often they retry, so a scope the person refused does not cause a loop of sign-in prompts.

In 2026-07-28 the client asks for the union of the scopes it already had and the new ones, so a step-up never asks for fewer scopes than before.

## Per-user or shared credentials

The specification describes how a client gets a token. It does not say whose token an automated agent should use. That is a design decision with real consequences:

- **One shared connection.** An admin connects the server once, and every workflow uses that token. Simple, and right for a service account that should act the same for everyone. But every user of the agent acts with that one account's rights.
- **<Term id="delegated-credentials">Delegated credentials</Term>.** Each person connects their own account. An agent run started by Alice calls the server as Alice, so it sees only what Alice may see, and the server's audit log names her. Runs with no person behind them, such as a schedule or webhook, need an explicit rule for whose account to use.

A good rule of thumb: if the server holds per-person data, use per-user connections, and never let a missing connection fall back to a shared one silently.

## How L2M handles it

L2M is an MCP client toward the servers your agents call, and an MCP server toward clients that call it through the gateway.

**As a client (the [MCP server registry](/product/mcp-server-registry)).** An HTTP server registered with auth type **OAuth** is connected with the flow above:

- L2M reads the `401` challenge, then the protected resource metadata, then the authorization server metadata (RFC 8414 or OpenID Connect discovery).
- It uses a client id you entered (pre-registration) or, when you leave it empty, registers itself with dynamic client registration as a public client. It does not support client metadata documents yet.
- The sign-in uses PKCE with `S256`, and L2M refuses an authorization server that does not advertise it. It sends a random `state` and the `resource` parameter.
- The scope is the one you set on the server, else the one from the challenge, else `scopes_supported`.
- The `state` is single-use, expires after 10 minutes by default, and is bound to the sign-in session that started the connection. Discovery and token endpoints must use HTTPS, except on loopback addresses for local testing, and if the resource metadata names a resource, it must be on the server's own origin.
- Tokens are stored encrypted through the secret service, are never returned by the API or written to logs, and are refreshed shortly before they expire and once more after a `401`.

By default a server has one shared connection. For an OAuth server, an admin can switch it to **each user's own account**: people connect under **My connections**, runs use the connection of the person who started them, and a missing connection fails the call instead of falling back to a shared credential. See [Delegated credentials](/product/mcp-server-registry#delegated-credentials).

**As a server (the [MCP gateway](/product/mcp-gateway)).** Clients that call L2M use a bearer token per client, created in the studio, shown once and stored as a hash. The gateway calls upstream servers with the credential the registry holds for each server (for a per-user server, the connection of the client's owner), never with the client's token, so there is no passthrough.

As a client, L2M also applies the 2026-07-28 additions described above: it checks the `iss` parameter of the authorization response against the issuer it expected, refuses a response without `iss` when the authorization server promised one, and after a `403` `insufficient_scope` answer asks for the union of the old and the challenged scopes on the next connect ([OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers)). By default the gateway speaks protocol versions 2025-11-25, 2025-06-18 and 2025-03-26, and the client asks servers for 2025-06-18; 2026-07-28 is opt-in on both sides.

## Checklist

For a client:

- Use OAuth only for HTTP servers; give stdio servers credentials through their environment.
- Follow `resource_metadata` from the `401`, then the well-known fallbacks.
- Refuse authorization servers that do not advertise `S256` PKCE.
- Send `resource` on both the authorization and the token request.
- Use a single-use, short-lived `state`, and require HTTPS for every OAuth URL except loopback.
- Ask for the challenged scope, not every scope; cap step-up retries.
- Store tokens encrypted; never log them or show them in a UI.
- Decide per server: one shared connection, or each user's own.

For a server:

- Return `401` with `resource_metadata` and a `scope`.
- Serve protected resource metadata that names your authorization server.
- Check every token's audience; reject tokens issued for anything else.
- Never forward a client's token downstream.
- Keep `scopes_supported` minimal, and use `403 insufficient_scope` for step-up.

## Further reading

- [MCP specification, 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (modelcontextprotocol.io)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) (modelcontextprotocol.io)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) (IETF)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html) (IETF)
- In L2M: [OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers), [MCP gateway clients](/product/mcp-gateway#clients), [Secrets](/security/secrets)
