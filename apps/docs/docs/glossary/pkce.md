---
title: "PKCE: proof key for OAuth code exchange"
term: "PKCE"
topic: security
definition: "Proof Key for Code Exchange (RFC 7636): the OAuth client sends a hash of a one-time secret when it starts a sign-in and the secret itself when it redeems the code, so a stolen authorization code is useless to anyone else."
description: "PKCE binds an OAuth authorization code to the client that asked for it, so a stolen code is useless. How S256 works and why MCP requires it."
related: [oauth-2-1, resource-indicator, dynamic-client-registration, oidc, protected-resource-metadata]
guide: [/learn/mcp/authorization]
---

# PKCE

**Proof Key for Code Exchange (RFC 7636): the OAuth client sends a hash of a one-time secret when it starts a sign-in and the secret itself when it redeems the code, so a stolen authorization code is useless to anyone else.**

In the authorization code flow, the code travels through the browser back to the client's redirect URI. Anything that can see that redirect, such as another app on the same device that registered the same custom URL scheme, can grab the code. RFC 7636 was written for exactly that attack on public clients, which have no client secret to prove who they are at the token endpoint.

PKCE adds a proof that only the client that started the flow can give:

1. The client makes a `code_verifier`: a random string of 43 to 128 characters.
2. It sends `code_challenge = BASE64URL(SHA256(code_verifier))` and `code_challenge_method=S256` with the authorization request.
3. It sends the `code_verifier` itself with the token request.
4. The authorization server hashes the verifier, compares it with the stored challenge, and answers `invalid_grant` on a mismatch.

The code alone is no longer enough; the thief would also need the verifier, which never left the client.

## Example

The pair from RFC 7636's own example:

```text
code_verifier  = dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
code_challenge = E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM

GET /authorize?response_type=code&client_id=...&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=...
POST /token  grant_type=authorization_code&code=...&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

## Common confusion

- **`plain` is not a lighter S256.** With `plain` the challenge is the verifier, so anyone who sees the authorization request has the secret. OAuth 2.1 says a client capable of S256 "MUST use `S256`".
- **PKCE is not only for mobile apps.** RFC 7636 was written for public clients, but OAuth 2.1 says clients "MUST use `code_challenge` and `code_verifier`" in the code flow, apart from exceptions in its security section, and authorization servers must support them.
- **PKCE is not `state`.** `state` ties the response to the browser session that started it; PKCE ties the code to the client that will redeem it. MCP clients should use both.

MCP goes one step further: since OAuth gives no other way to learn whether a server supports PKCE, an MCP client must refuse to continue when the authorization server's metadata has no `code_challenge_methods_supported`.

## In L2M

Every [OAuth connection to a remote MCP server](/product/mcp-server-registry#oauth-for-remote-servers) uses S256 with a fresh verifier, and L2M refuses an authorization server whose metadata does not list `S256`. The verifier stays in the pending authorization on the API, keyed by a single-use `state`, and is sent only with the token request. L2M's own [OIDC sign-in](/security/auth-rbac#oidc-single-sign-on) uses the same method, with `state` and `nonce`; its verifier is kept in a short-lived encrypted login cookie. It refuses an identity provider whose metadata lists `code_challenge_methods_supported` without `S256`, and never falls back to `plain`. When the field is missing, sign-in still sends S256, as RFC 7636 advises, since a provider without PKCE ignores it. With no client secret set, PKCE alone protects the code.

## Further reading

- [RFC 7636: Proof Key for Code Exchange by OAuth Public Clients](https://www.rfc-editor.org/rfc/rfc7636.html) (IETF)
- [The OAuth 2.1 Authorization Framework (draft 13)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13) (IETF)
- [MCP specification 2026-07-28: authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) (modelcontextprotocol.io)
