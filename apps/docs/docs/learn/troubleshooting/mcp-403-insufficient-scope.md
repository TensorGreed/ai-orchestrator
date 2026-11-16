---
title: "MCP 403 insufficient_scope: step-up authorization"
sidebarTitle: "403 insufficient_scope"
description: "A remote MCP server accepted your token but refused a tool with 403 insufficient_scope. How to read the challenge and fix it with step-up authorization."
level: intermediate
about: oauth-2-1
related: [oauth-2-1, least-privilege, delegated-credentials, mcp-tool, mcp-server]
---

# MCP 403 Forbidden: error="insufficient_scope"

A `403` with `error="insufficient_scope"` means your token is valid but does not carry the permission this one operation needs, so signing in again with the same scopes will not help. The person who connected the server has to authorize again and grant the extra scope named in the challenge (step-up authorization); retrying the call unchanged only repeats the refusal.

The [authorization guide](/learn/mcp/authorization#scopes-and-step-up) introduces scopes. This page is about diagnosing and fixing the refusal.

## What it means

An MCP server that uses OAuth is a resource server. On every request it checks two things: is the token valid, and does it allow this operation. The two failures get different answers, defined for bearer tokens in RFC 6750, section 3.1, and used unchanged by the MCP specification:

| | `401 Unauthorized` | `403 Forbidden` with `insufficient_scope` |
|---|---|---|
| What failed | No token, or the token is expired, revoked, malformed or for another server | The token is fine, but "the request requires higher privileges than provided by the access token" (RFC 6750) |
| `WWW-Authenticate` error | `invalid_token`, or no error at all when the request had no token | `insufficient_scope` |
| What the client does | Refresh the token, or run the sign-in flow | Run the sign-in flow again with more scopes |
| Can it succeed without a person? | Often: a refresh token gets a new access token | Usually not: someone must consent to the new scope |

The MCP specification (2025-11-25, "Scope Challenge Handling") says a server that refuses for lack of scope should answer:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope",
                         scope="files:read files:write user:profile",
                         resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource",
                         error_description="Additional file write permission required"
```

Read the parameters this way:

- **`scope`** is the set of scopes needed to satisfy this request, space separated. The specification tells clients to treat the challenged scopes as authoritative for the current operation. The 2025-11-25 revision also tells them not to assume any set relation between challenged scopes and `scopes_supported` in the server's metadata.
- **`resource_metadata`** points to the same protected resource metadata as the `401` challenge, so the client knows which authorization server to go back to.
- **`error_description`** is optional text for humans.

How much a server puts in `scope` differs between revisions. The 2025-11-25 revision lists a minimum approach (the newly needed scopes, plus granted ones if still required), a recommended one (granted and new scopes together) and an extended one (also related scopes that usually go together). The current 2026-07-28 revision says the challenge describes the scopes this operation needs and need not repeat the scopes the client already has. It makes keeping them the client's job: on step-up, the client requests the union of the scopes it asked for before and the challenged ones. It also asks servers to name every scope an operation needs in a single challenge, rather than one missing scope at a time.

## Causes (most to least likely)

1. **The tool needs a scope that the first sign-in did not ask for.** This is the normal case and by design. Servers keep `scopes_supported` minimal and the first `401` challenge names only what basic use needs, following least privilege. The first write, admin or cross-account tool then triggers the `403`.
2. **The person or the authorization server granted less than was asked.** RFC 6749, section 3.3, lets the authorization server "fully or partially ignore the scope requested by the client", and requires it to return the `scope` parameter in the token response when the granted scope differs. A consent screen with unchecked boxes, or a policy that strips a scope for some users, produces a token that is short from the start.
3. **The client asked for a fixed scope list.** A scope typed into the client's configuration overrides what the server asks for. If that list misses the tool's scope, every new sign-in reproduces the problem.
4. **Step-up asked only for the new scopes.** A client that requests just the challenged scopes, against a server whose challenge lists only what the operation needs, gets a token for the new operation that has lost the old scopes. The next ordinary call then fails with its own `403`, and the two calls take turns refusing.
5. **The account is not allowed the scope at all.** The scope exists, but this user's role does not permit it. Re-consenting cannot fix that; an administrator of the service has to grant the role.
6. **It is not a scope problem.** A `403` without `insufficient_scope` comes from somewhere else: the Streamable HTTP transport requires servers to answer `403` when the `Origin` header is present and invalid, and proxies, firewalls and the server's own permission checks also use `403`.

## How to check

**1. Read the whole challenge.** Make the refused call with the token your client uses and keep the headers. Use a test token, not a production one, in your shell:

```bash
curl -s -o /dev/null -D - -X POST https://mcp.example.com/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_file","arguments":{}}}' \
  | grep -i -E '^HTTP|www-authenticate'
```

A real MCP server may also need the `MCP-Protocol-Version` and session headers your client sends; copy them from the client's debug log. No `insufficient_scope` in the header means cause 6.

**2. Compare with what the token holds.** Look at the `scope` your client recorded from the token response. If the token is a JWT, its claims usually include a `scope` or `scp` claim; decode only the middle part locally, never in an online tool. If the granted scope is missing scopes you asked for, it is cause 2.

**3. Check the client's scope setting.** A fixed scope in the configuration that does not include the challenged scope is cause 3.

**4. Watch the next sign-in.** After the refusal, the client's next authorization URL should carry `scope=` with the old and the challenged scopes together. If it carries only the new ones, it is cause 4.

## Fix

- **Missing scope (cause 1):** let the person who owns the connection authorize again, with the union of the granted and the challenged scopes. That is a browser sign-in with consent; an agent cannot do it on its own.
- **Granted less (cause 2):** sign in again and accept the requested permissions on the consent screen. If a policy strips the scope, the authorization server's administrator has to allow it for this client or user.
- **Fixed scope list (cause 3):** add the scope to the client's setting, or clear the setting so the client uses the server's challenge.
- **Lost scopes (cause 4):** request the union of the earlier and the challenged scopes, as 2026-07-28 requires. If your client cannot, ask the server's operator to include the granted scopes in the challenge too (the 2025-11-25 "recommended approach").
- **Not allowed (cause 5):** get the role in the service, or let a different account (a <Term id="service-account">service account</Term> with that permission) run that tool.
- **Not a scope error (cause 6):** follow the body and the server's logs; for an `Origin` refusal, check which origins the server allows.

Do not retry the same call in a loop. The specification asks clients to limit step-up attempts and to treat repeated refusals for the same operation as a permanent failure, so a scope the person declined does not turn into endless sign-in prompts.

For server authors: answer with `403` and a full challenge as shown above, always include `scope` with every scope the operation needs, and keep the same scope strategy everywhere. A `403` without a challenge leaves the client nothing to act on.

## If you run agents in L2M

When a server refuses a call with `403` and an `insufficient_scope` challenge, L2M fails that call at once:

- It is sent once and never retried, and it does not count against the server's health or its circuit breaker.
- The agent, or the MCP Tool node, gets a tool error that names the scope. It starts "MCP server refused tools/call: the access token lacks the scope it needs" and tells the person to reconnect. A refused tool listing fails the same way.
- For a server connected with OAuth, L2M stores the challenged scopes encrypted with the token. The server page keeps working for other tools and shows the missing scope as its last error; the first challenge for a scope is audited as `mcp_server.oauth_scope_challenged`.
- The next **Connect** (or **Reconnect**) on the [server page](/product/mcp-server-registry#oauth-for-remote-servers) asks for the scope granted before, the scope a first connect would ask for, and the newly challenged scopes together. The server page shows the scope the token was granted.
- Step-up needs a person: there is no automatic browser flow during a run. For a server where each user connects their own account ([delegated credentials](/product/mcp-server-registry#delegated-credentials)), that user reconnects under **My connections**.
- For a server with a static bearer token rather than OAuth, the same refusal is reported, and the fix is a token with that scope.

To keep refusals rare in agent runs, give the agent only tools whose scopes the connection has, using [tool policy](/product/mcp-tool-policy). Ask for broad write scopes only on connections that need them, in line with [least privilege for agents](/learn/security/least-privilege-for-agents).

If the error is about the client id rather than the token, see [OAuth invalid_client](/learn/troubleshooting/mcp-oauth-invalid-client). If the client cannot even find the authorization server, see [Failed to fetch authorization server metadata](/learn/troubleshooting/failed-to-fetch-authorization-server-metadata).

## Further reading

- [MCP specification, 2025-11-25: Authorization, scope challenge handling](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-challenge-handling) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (modelcontextprotocol.io)
- [RFC 6750: Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html), section 3 (IETF)
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html), section 3.3 (IETF)
- In L2M: [OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers), [MCP 2026-07-28 support: OAuth](/product/mcp-2026-07-28#oauth), [MCP authorization](/learn/mcp/authorization)
