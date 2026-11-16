---
title: "MCP OAuth invalid_client: client ID and registration"
sidebarTitle: "OAuth invalid_client"
description: "Why connecting a remote MCP server fails with invalid_client: a stale registered client id, no dynamic registration, a redirect URI mismatch or wrong auth."
level: intermediate
about: oauth-2-1
related: [oauth-2-1, pkce, delegated-credentials, mcp-client, streamable-http]
---

# MCP OAuth error: invalid_client

`invalid_client` means the authorization server does not accept the client identity your <Term id="mcp-client">MCP client</Term> presented: it does not know the client id, the client authenticated in a way it does not allow, or the registration does not match the request. The fix is almost always on the client side: throw away the stored registration and register again, or enter a client id that was registered for exactly the redirect URL your client uses.

This page is about the errors around the client id. For the authorization flow itself (the `401` challenge, metadata, <Term id="pkce">PKCE</Term>, the `resource` parameter), read [MCP authorization](/learn/mcp/authorization) first.

## What it means

In MCP authorization the MCP client is an <Term id="oauth-2-1">OAuth 2.1</Term> client, and every OAuth client needs an identity at the authorization server before it can ask for a token. MCP clients get one in three ways: a client id someone registered by hand (pre-registration), a client ID metadata document (the client id is an HTTPS URL), or dynamic client registration (RFC 7591), where the client posts its details to the server's `registration_endpoint` and gets a client id back. The [authorization guide](/learn/mcp/authorization#client-registration-three-ways-to-get-a-client-id) explains the three.

`invalid_client` is defined in RFC 6749, section 5.2, as an error of the token endpoint: "Client authentication failed (e.g., unknown client, no client authentication included, or unsupported authentication method)." The server may answer it with HTTP `401`. The same family of problems shows up in two more places, and where you see the error tells you a lot:

| Where it appears | What you see | What it usually means |
|---|---|---|
| The sign-in page in the browser | An error page from the authorization server, often "invalid client" or "invalid redirect URI", and no redirect back | The client id is unknown, or the redirect URI does not match its registration |
| The token request after sign-in | `invalid_client` (often HTTP `401`) | Unknown client, or wrong or missing client authentication |
| The registration request | HTTP `400` with `invalid_redirect_uri` or `invalid_client_metadata` | The server refused to create the client at all |
| A token refresh, days later | `invalid_client` or `invalid_grant` | The registration was deleted or expired since the last sign-in |

The browser case surprises people. RFC 6749, section 4.1.2.1, says that when the client id is missing or invalid, or the redirect URI is missing, invalid or mismatching, the authorization server should tell the person and must not redirect back to the client. So your MCP client never learns what went wrong: the popup just shows the server's error page, and the client waits until it gives up.

Registration errors come from RFC 7591, section 3.2.2: `invalid_redirect_uri` ("The value of one or more redirection URIs is invalid") and `invalid_client_metadata` ("The value of one of the client metadata fields is invalid and the server has rejected this request"), both with HTTP `400`.

## Causes (most to least likely)

1. **A stale dynamically registered client id.** The client registered once, cached the client id, and keeps using it. The authorization server has since forgotten it: a development server restarted with registrations kept in memory, a database was reset, unused clients were cleaned up, or the registration expired. RFC 7591 leaves it to the authorization server whether and when registrations expire, so a client cannot assume a client id lives forever.
2. **The MCP server now uses a different authorization server.** The server moved to a new identity provider or tenant, and the client still sends the client id from the old one. The 2026-07-28 revision of the specification makes the rule explicit: clients must key pre-registered and dynamically registered credentials by the issuer, must not reuse them with another authorization server, and must register again when it changes. A client metadata document URL is the exception: it is portable and needs no new registration.
3. **The redirect URI does not match.** Authorization servers compare redirect URIs exactly. A pre-registered client with `http://localhost:3000/callback` fails when the client sends `http://127.0.0.1:3000/callback`, another port, a trailing slash, or `https` instead of `http`. The specification also requires every redirect URI to be either `localhost` or HTTPS.
4. **The client authenticates the wrong way.** The client registered as a public client (`token_endpoint_auth_method: none`, PKCE and no secret) but the server expects a secret, or the other way round. Or a secret is sent in the `Authorization` header when the server only accepts it in the body, or the secret has expired (`client_secret_expires_at`).
5. **The authorization server does not offer dynamic registration.** Its metadata has no `registration_endpoint`, so a client that relies on registration has nothing to send. Someone pasted a client id from another environment instead, and that id does not exist here.
6. **The registration itself is refused.** The server rejects a requested grant type, scope or `application_type`, the redirect URI's scheme, or requires an initial access token before anyone may register (RFC 7591 allows servers to limit who can register).

## How to check

Work through the discovery chain by hand. Replace the URL with your server's MCP endpoint; `jq` only formats the output.

**1. Find the authorization server.** Send an unauthenticated request and read the challenge:

```bash
MCP=https://mcp.example.com/mcp
curl -s -o /dev/null -D - -X POST "$MCP" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | grep -i -E '^HTTP|www-authenticate'
```

Fetch the `resource_metadata` URL from the header and note `authorization_servers`. If this step fails, the problem is discovery, not the client id: see [Failed to fetch authorization server metadata](/learn/troubleshooting/failed-to-fetch-authorization-server-metadata).

**2. See which registration methods the server offers.** For an issuer without a path:

```bash
curl -s https://auth.example.com/.well-known/oauth-authorization-server \
  | jq '{issuer, registration_endpoint, client_id_metadata_document_supported, token_endpoint_auth_methods_supported}'
```

No `registration_endpoint` means no dynamic registration (cause 5). `token_endpoint_auth_methods_supported` without `none` means the server does not accept public clients (cause 4). Compare `issuer` with the one your stored client id came from (cause 2).

**3. Read the redirect URI your client really sends.** When the sign-in popup opens, copy its address and decode the query: check `client_id` and `redirect_uri` character by character against the registration (cause 3).

**4. On a server you control, try a registration by hand.** This creates a client, so only do it on a test or development server:

```bash
curl -s -X POST https://auth.example.com/register \
  -H 'content-type: application/json' \
  -d '{"client_name":"test","redirect_uris":["https://l2m.example.com/api/mcp/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}' \
  -w '\nHTTP %{http_code}\n'
```

A `400` with `invalid_redirect_uri` or `invalid_client_metadata` and an `error_description` tells you which field the server dislikes (cause 6).

## Fix

- **Stale client id (cause 1):** delete the stored registration in your client and connect again, so it registers afresh. Signing in again alone is not enough when the client reuses the cached id. If it keeps happening, ask the server's operator whether registrations are kept in memory or cleaned up, and prefer a pre-registered client or a client metadata document, which do not depend on stored registrations. The 2026-07-28 revision deprecates dynamic registration in favour of client metadata documents, though it stays available for servers that do not support them.
- **New authorization server (cause 2):** register with the new one (or let the client register again) and replace the client id. Do not copy a client id or secret from one authorization server to another.
- **Redirect URI (cause 3):** register exactly the URI the client sends, or configure the client to send exactly the registered one. Pick one host form (`localhost` or `127.0.0.1`) and keep it.
- **Client authentication (cause 4):** match `token_endpoint_auth_method` on both sides. A client with no secret must be registered as public; a confidential client needs its current secret.
- **No dynamic registration (cause 5):** register the client in the authorization server's admin console, then enter the client id (and secret, if it has one) in your MCP client. Check that the id comes from the same tenant and environment as the server.
- **Refused registration (cause 6):** fix the field the `error_description` names, or ask the operator for an initial access token or a pre-registered client.

## If you run agents in L2M

L2M connects OAuth servers from the [MCP server registry](/product/mcp-server-registry#oauth-for-remote-servers). It picks a client id in this order: the client id entered on the server, then its own client metadata document (opt-in with `MCP_OAUTH_CLIENT_METADATA_ENABLED`, used only when the authorization server advertises `client_id_metadata_document_supported`), then dynamic registration as a public client with `application_type` set. With none of these, **Connect** stops with "The authorization server does not support dynamic client registration. Register L2M as a client there and enter its client id on the server."

What you see for each failure:

- A refused registration: "Dynamic client registration failed:" followed by the server's `error_description`.
- A refused code exchange: "Token request failed:" followed by the reason, shown in the popup and on the server page.
- A refused refresh: the connection shows **Error**, and calls fail with "Token refresh failed:" and the reason. On a shared connection the message ends "An admin may need to reconnect it."; on a per-user connection it tells the user to connect again under **My connections**.
- An error on the authorization server's own page (an unknown client id or a redirect mismatch): the popup stays on that page, as explained above.

How to reset:

- **Disconnect** on the server page deletes the tokens and the stored client registration; the next **Connect** registers again. **Reconnect** keeps a dynamic registration and reuses it, as long as the authorization server and the redirect URL are unchanged. So for a stale client id, press **Disconnect** first.
- For a server where each user connects their own account (<Term id="delegated-credentials">delegated credentials</Term>), each user disconnects and connects again under **My connections**.
- The redirect URL is `<base>/api/mcp/oauth/callback`, where the base is `MCP_OAUTH_REDIRECT_BASE_URL`, else `MCP_GATEWAY_PUBLIC_URL`, else the first `WEB_ORIGIN`. The server page shows the URL in use; register exactly that one for a pre-registered client ([the redirect URL](/product/mcp-server-registry#the-redirect-url)). When the base changes, L2M registers again on its own, because a registration is reused only for the same redirect URL.
- A client id you entered is bound to the authorization server of its first successful connection. If the MCP server later names another one, **Connect** stops with a message that begins "The authorization server changed" instead of sending the id there. Enter a client id from the new server, or an admin presses **Reset** next to the binding ([MCP 2026-07-28 support](/product/mcp-2026-07-28#oauth)).

Tokens and the registration are stored only as an encrypted secret, never shown by the API. If the token works but a tool is refused, that is a different error: see [403 insufficient_scope](/learn/troubleshooting/mcp-403-insufficient-scope).

## Further reading

- [MCP specification, 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html), sections 4.1.2.1 and 5.2 (IETF)
- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://www.rfc-editor.org/rfc/rfc7591.html) (IETF)
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html) (IETF)
- In L2M: [OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers), [Client metadata document](/product/mcp-server-registry#client-metadata-document), [MCP authorization](/learn/mcp/authorization)
