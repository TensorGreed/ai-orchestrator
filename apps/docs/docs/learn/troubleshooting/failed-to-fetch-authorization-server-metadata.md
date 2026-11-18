---
title: "\"Failed to fetch authorization server metadata\" in MCP"
sidebarTitle: "Authorization metadata"
description: "The MCP client could not discover where to sign in. How OAuth metadata is found, and the path, issuer, redirect and TLS problems that break it."
level: intermediate
about: oauth-2-1
related: [oauth-2-1, pkce, streamable-http, ssrf, mcp-client]
---

# Failed to fetch authorization server metadata (MCP OAuth)

This error means the MCP client could not finish OAuth discovery: it never found, or could not use, the document that says where to sign in and where to get tokens. The usual causes are a metadata URL built for the wrong path, an `issuer` that does not match character for character, or a network or TLS problem between the client and the identity provider. You can find out which one in a few minutes with `curl`.

Clients word this error differently ("failed to discover", "could not load metadata", "OAuth discovery failed"), but they all fail at the same point in the chain described below. For the authorization flow as a whole, see [MCP authorization](/learn/mcp/authorization).

## What it means

Before a client can send anyone to a sign-in page, it has to discover two documents, in order:

1. **Protected resource metadata** (RFC 9728), served by the MCP server. It must list at least one entry in `authorization_servers`. The client finds it through the `resource_metadata` parameter of the server's `401` challenge, or, without one, at well-known URLs: first the one built from the MCP endpoint's path, then the root. For `https://example.com/public/mcp` those are `https://example.com/.well-known/oauth-protected-resource/public/mcp` and `https://example.com/.well-known/oauth-protected-resource`.
2. **Authorization server metadata**, served by the authorization server named in step 1. MCP clients must support both RFC 8414 and OpenID Connect Discovery, and must try the well-known URLs in this order:

| Issuer | URLs tried, in order |
|---|---|
| `https://auth.example.com` | `/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration` |
| `https://auth.example.com/tenant1` | `/.well-known/oauth-authorization-server/tenant1`, then `/.well-known/openid-configuration/tenant1`, then `/tenant1/.well-known/openid-configuration` |

Note where the path goes. RFC 8414 inserts the well-known string "between the host component and the path component", so the OAuth document for a tenant issuer is `/.well-known/oauth-authorization-server/tenant1`, not `/tenant1/.well-known/oauth-authorization-server`. Only OpenID Connect Discovery also allows appending.

Once a document is fetched, two exact-match rules apply. RFC 8414, section 3.3, and OpenID Connect Discovery, section 4.3, both say the `issuer` in the document must be identical to the issuer used to build the URL, and the 2026-07-28 MCP revision repeats it: if they differ, the client must not use the metadata. RFC 9728 has the same rule for the `resource` value of protected resource metadata. These rules stop one server from handing out another's endpoints, but they also make a trailing slash fatal.

Finally, the specification requires every authorization server endpoint to use HTTPS, and requires clients to refuse an authorization server whose metadata has no `code_challenge_methods_supported`, since that field is the only way to know it supports <Term id="pkce">PKCE</Term>.

## Causes (most to least likely)

1. **Path handling for an issuer with a path.** The identity provider serves its metadata only at an appended URL such as `/tenant1/.well-known/oauth-authorization-server`, which no rule tries. Or the MCP server's challenge carries no `resource_metadata`, and it serves its protected resource metadata somewhere neither well-known URL points, such as `/mcp/.well-known/oauth-protected-resource`.
2. **The issuer does not match exactly.** `authorization_servers` says `https://auth.example.com/` and the metadata says `"issuer": "https://auth.example.com"`, or the case, port or tenant segment differ. The document loads but is rejected.
3. **The server does not do OAuth, or the challenge is lost.** The server answers `200` or a plain `403` instead of `401`, or a proxy in front of it removes the `WWW-Authenticate` header and the server does not serve the well-known document either. Then there is nothing to discover.
4. **Network and TLS.** The identity provider is on a private network the client cannot reach, DNS fails, an outbound proxy blocks it, or its certificate is signed by an internal CA the client's runtime does not trust.
5. **Redirects and HTML.** The well-known URL redirects (http to https, or to a login page), or a single-page app answers every unknown path with `200` and an HTML page. The client gets something that is not a JSON object.
6. **Plain HTTP.** Discovery or token URLs use `http://`, which the specification does not allow. Some clients accept it on a loopback host for local testing, but never elsewhere.
7. **Incomplete metadata.** The document lacks `authorization_endpoint`, `token_endpoint` or `code_challenge_methods_supported`.

## How to check

Follow the chain by hand. Replace the URLs with yours; `jq` only formats the output.

**1. Get the challenge.**

```bash
MCP=https://mcp.example.com/mcp
curl -s -o /dev/null -D - -X POST "$MCP" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | grep -i -E '^HTTP|www-authenticate'
```

You want `401` and `WWW-Authenticate: Bearer resource_metadata="…"`. No `401` at all is cause 3.

**2. Fetch the protected resource metadata** from that URL, or from the well-known URLs:

```bash
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp \
  | jq '{resource, authorization_servers}'
```

Copy the first entry of `authorization_servers` exactly, including any trailing slash.

**3. Try every authorization server URL** the specification lists, and print the status and any redirect:

```bash
ISSUER=https://auth.example.com/tenant1
HOST=${ISSUER%/tenant1}   # the origin; adjust if your issuer has another path
for p in /.well-known/oauth-authorization-server/tenant1 \
         /.well-known/openid-configuration/tenant1 \
         /tenant1/.well-known/openid-configuration; do
  curl -s -o /dev/null -w '%{http_code} %{content_type} %{redirect_url}  '"$p"'\n' "$HOST$p"
done
```

All `404` is cause 1. A `3xx` with a redirect URL, or `text/html`, is cause 5. A status of `000` means no HTTP answer at all; rerun that URL with `curl -v`, and a connection or certificate error there is cause 4.

**4. Compare the issuer** of the first document that answers `200`:

```bash
curl -s "$HOST/.well-known/oauth-authorization-server/tenant1" \
  | jq '{issuer, authorization_endpoint, token_endpoint, code_challenge_methods_supported}'
```

`issuer` must equal `$ISSUER` exactly (cause 2), the endpoints must be `https` (cause 6), and `code_challenge_methods_supported` must include `S256` (cause 7).

Run these from the machine where the client runs, not from your laptop: the network path is part of the problem.

## Fix

- **Path handling (cause 1):** on the identity provider, serve metadata at the inserted path or at the OpenID Connect path; on the MCP server, return `resource_metadata` in the `401` challenge so clients do not have to guess.
- **Issuer mismatch (cause 2):** make `authorization_servers` in the protected resource metadata use the identity provider's `issuer` exactly as its metadata prints it.
- **No challenge (cause 3):** return `401` with `WWW-Authenticate` for unauthenticated requests, and make sure proxies pass the header through. If the server uses a static API key instead of OAuth, configure that key in the client and skip OAuth.
- **Network and TLS (cause 4):** allow outbound HTTPS from the client's host to the identity provider. For an internal CA in a Node.js client, `NODE_EXTRA_CA_CERTS` points at a PEM file of extra trusted certificates; it is read only when the process starts, so restart after setting it. Never turn off certificate checks.
- **Redirects and HTML (cause 5):** publish the metadata at the final URL so no redirect is needed, and make the well-known paths return JSON.
- **Plain HTTP (cause 6):** use HTTPS. Keep plain HTTP for a local test identity provider on loopback, and only with a client that allows it.
- **Incomplete metadata (cause 7):** enable PKCE on the identity provider so it advertises `S256`.

If discovery succeeds and sign-in then fails with `invalid_client`, go on to [OAuth invalid_client](/learn/troubleshooting/mcp-oauth-invalid-client).

## If you run agents in L2M

L2M runs discovery when someone presses **Connect** on an OAuth server in the [MCP server registry](/product/mcp-server-registry#oauth-for-remote-servers), and shows the reason when it stops. Its messages map to the causes above:

| L2M message (start) | Cause |
|---|---|
| "Could not find OAuth protected resource metadata for … The server may not support OAuth." | 1 or 3 |
| "The server's protected resource metadata names no authorization server." | 3 |
| "Could not load authorization server metadata for …", with the last URL tried and its HTTP status | 1 |
| "The authorization server metadata at … names the issuer …, not …; refusing to use it." | 2 |
| "Request to … timed out after 15000 ms." or "Request to … failed: …" | 4 or 5 |
| "… did not return a JSON object (HTTP …)." | 5 |
| "… must use https (got …)." | 6 |
| "Authorization server metadata lacks authorization_endpoint or token_endpoint." | 7 |
| "The authorization server does not advertise PKCE with S256 …" | 7 |
| "The protected resource metadata at … names the resource …, which is neither … nor a parent path of it …" or "… names no resource …" | The MCP server's `resource` is not its URL or a parent path of it on the same origin (another host, port, scheme or path, a partial path segment such as `/m` for `/mcp`, or a different query). Enter the server URL its metadata describes, or have the server publish its own URL as `resource`. |

How L2M discovers:

- It reads the challenge from an unauthenticated `initialize`, then from a 2026-07-28 `server/discover` request when `initialize` was not challenged, and falls back to the well-known URLs. It sends the server's configured custom headers with the probe, so gateways that route on them still answer.
- It uses the first entry of `authorization_servers` and tries the URLs in the table above, in that order.
- Every OAuth request has a 15-second timeout, and redirects are never followed.
- HTTPS is required except on loopback addresses, so a local test identity provider on `localhost` works.
- The protected resource metadata must name a `resource`. RFC 9728, section 3.3, requires it to be identical to the MCP server's URL as you entered it. L2M also accepts, as the reference MCP TypeScript SDK client does, a parent path on the same origin, on a path-segment boundary: `https://mcp.example.com` or `https://mcp.example.com/mcp` for `https://mcp.example.com/mcp`, but not `https://mcp.example.com/m`. Anything else (another host, port or scheme, another path, a different query, a fragment) is refused, and the `resource` is sent exactly as the server named it.
- With the opt-in `MCP_OAUTH_BLOCK_PRIVATE_HOSTS=true`, OAuth requests to private, loopback, link-local and cloud metadata addresses are refused (the MCP server's own host and port stay allowed) with a message that names `MCP_OAUTH_PRIVATE_HOST_ALLOWLIST`. Add an identity provider on a private network to that list; link-local and cloud metadata addresses stay refused even when listed. This setting is a defence against <Term id="ssrf">server-side request forgery</Term> through hostile metadata.

The L2M API is a Node.js process, so the `NODE_EXTRA_CA_CERTS` advice above applies to it. Set it in the API's environment and restart the API.

Once connected, a refused tool call is a different problem: see [403 insufficient_scope](/learn/troubleshooting/mcp-403-insufficient-scope). If the server needs no OAuth at all, set its auth type to a bearer token or none instead.

## Further reading

- [MCP specification, 2026-07-28: Authorization server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728.html) (IETF)
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html) (IETF)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html) (OpenID Foundation)
- [Node.js: NODE_EXTRA_CA_CERTS](https://nodejs.org/api/cli.html#node_extra_ca_certsfile) (nodejs.org)
- In L2M: [OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers), [MCP 2026-07-28 support: OAuth](/product/mcp-2026-07-28#oauth), [MCP authorization](/learn/mcp/authorization)
