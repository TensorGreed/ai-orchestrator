---
title: "OAuth vs API keys for MCP servers"
sidebarTitle: "OAuth vs API keys for MCP"
description: "Static API keys are simple; OAuth gives per-user, scoped, revocable access. What the MCP spec requires for remote servers and when a key is still fine."
level: intermediate
about: oauth-2-1
related: [oauth-2-1, delegated-credentials, token-passthrough, secret-reference, least-privilege, service-account]
---

# OAuth vs API keys for MCP servers

An API key is one long-lived secret that an MCP client sends with every request: simple to set up, but whoever holds it acts with all of its rights, for everyone, until someone rotates it. An <Term id="oauth-2-1">OAuth</Term> access token is requested for one client, one server and a set of scopes, usually on behalf of one person who signed in and agreed. It expires, it can be refreshed, and it can be revoked for one user without touching anyone else. The MCP specification makes authorization optional, says local stdio servers take credentials from their environment (in practice, often a key), and defines an OAuth 2.1 based flow for HTTP servers. So the answer depends on where the server runs and whose data it touches.

## The two models

<figure>
<svg viewBox="0 0 660 250" role="img" aria-labelledby="ok-fig-title ok-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:660px">
  <title id="ok-fig-title">How an API key and an OAuth token reach an MCP server</title>
  <desc id="ok-fig-desc">Top: an admin copies one API key into the client's secret store, and every call from every user sends that same key to the MCP server. Bottom: each user signs in at an authorization server, which issues a token for that user, scoped to that MCP server; each call sends that user's token.</desc>
  <defs><marker id="ok-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <text x="20" y="22" font-size="12">API key</text>
    <rect x="20" y="32" width="130" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="85" y="59" text-anchor="middle">Admin copies key</text>
    <rect x="250" y="32" width="150" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="325" y="52" text-anchor="middle">MCP client</text>
    <text x="325" y="68" text-anchor="middle" font-size="11">same key for all users</text>
    <rect x="500" y="32" width="140" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="59" text-anchor="middle">MCP server</text>
    <path d="M150 54 L248 54" stroke="currentColor" fill="none" marker-end="url(#ok-arrow)"/>
    <path d="M400 54 L498 54" stroke="currentColor" fill="none" stroke-dasharray="4 3" marker-end="url(#ok-arrow)"/>
    <text x="450" y="46" text-anchor="middle" font-size="11">key</text>
    <text x="20" y="122" font-size="12">OAuth</text>
    <rect x="20" y="132" width="130" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="85" y="152" text-anchor="middle">User signs in</text>
    <text x="85" y="168" text-anchor="middle" font-size="11">and consents</text>
    <rect x="20" y="196" width="130" height="44" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="85" y="216" text-anchor="middle">Authorization</text>
    <text x="85" y="232" text-anchor="middle">server</text>
    <rect x="250" y="132" width="150" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="325" y="152" text-anchor="middle">MCP client</text>
    <text x="325" y="168" text-anchor="middle" font-size="11">one token per user</text>
    <rect x="500" y="132" width="140" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="159" text-anchor="middle">MCP server</text>
    <path d="M85 176 L85 194" stroke="currentColor" fill="none" marker-end="url(#ok-arrow)"/>
    <path d="M150 218 L325 218 L325 178" stroke="currentColor" fill="none" marker-end="url(#ok-arrow)"/>
    <text x="240" y="210" text-anchor="middle" font-size="11">token for this server</text>
    <path d="M400 154 L498 154" stroke="currentColor" fill="none" stroke-dasharray="4 3" marker-end="url(#ok-arrow)"/>
    <text x="450" y="146" text-anchor="middle" font-size="11">user's token</text>
  </g>
</svg>
<figcaption>A key is copied once and shared by every call. An OAuth token is requested per user and per server, after that user agrees.</figcaption>
</figure>

| Question | API key | OAuth access token |
| --- | --- | --- |
| Who does it identify? | An account or an application, the same for every caller | A client acting for one user (or for itself), at one server |
| How is it obtained? | Copied from a dashboard into a config or secret store | A browser sign-in and consent, then a token exchange |
| What can it do? | Usually everything the account can, unless the service offers scoped keys | The scopes asked for and granted, for the resource named in the request |
| How long does it live? | Until someone rotates or deletes it | Usually short; a refresh token gets a new one |
| How is one user cut off? | Rotate the key, which cuts off everyone who uses it | Revoke that user's grant (a short-lived access token may work until it expires); others keep working |
| What does the server's audit log see? | The key's owner, for every call | The user the token was issued for |
| What does the client have to build? | Nothing beyond sending a header | Discovery, PKCE, the `resource` parameter, refresh, token storage |
| Typical fit | Local servers, internal service accounts, machine to machine | Remote servers with per-person data, many users, third-party services |

OAuth's own specification starts from the problems with sharing long-lived credentials. RFC 6749 lists them for the case where applications hold a user's password: they "are required to store the resource owner's credentials for future use", they "gain overly broad access", and resource owners "cannot revoke access to an individual third party without revoking access to all third parties". A shared API key has the same shape. OAuth answers with access tokens, which "represent specific scopes and durations of access".

## What the MCP specification says

The 2025-11-25 authorization specification is short on this point:

- Authorization is **OPTIONAL** for MCP implementations.
- When it is supported: "Implementations using an HTTP-based transport **SHOULD** conform to this specification."
- And: "Implementations using an STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment." In practice the client passes an API key to the server process as an environment variable.

So a key is not forbidden. But when an HTTP server does use MCP authorization, the rules are strict:

- The MCP server is an OAuth 2.1 resource server and publishes Protected Resource Metadata that names its authorization server.
- Clients **MUST** use PKCE, with `S256` when they can, and **MUST** send the `resource` parameter, so an authorization server that supports resource indicators issues a token for that one server only. Either way, the server must check that the token was issued for it.
- Tokens travel in the `Authorization: Bearer` header on every request. They "**MUST NOT** be included in the URI query string".
- Servers **MUST** check that a token was issued for them, and "**MUST NOT** pass through the token it received from the MCP client" to an API behind them. That rule is the ban on <Term id="token-passthrough">token passthrough</Term>.
- For public clients, authorization servers **MUST** rotate refresh tokens.

The 2026-07-28 revision keeps this model, requires clients to check the `iss` parameter of the authorization response when present, binds stored client registrations to the authorization server that issued them, and deprecates dynamic client registration in favour of client ID metadata documents. [MCP authorization](/learn/mcp/authorization) walks through the flow step by step.

## When an API key is still fine

- **A local stdio server.** The specification itself sends you to the environment. A filesystem or code-search server on the same machine gets its key as an environment variable. Nobody else calls it.
- **A service account by design.** A nightly report agent that reads a metrics API should act the same for everyone, as a <Term id="service-account">service account</Term>. One key with read-only rights is honest about that.
- **An internal server behind your own gateway.** If the gateway authenticates each caller and the key never leaves the server side, a key between the gateway and the server is fine.
- **The service offers nothing else.** Many APIs only issue keys. Then make the key as small as the service allows: read-only if possible, one key per agent, and an expiry.

Treat a key as a secret in every case. Keep it in an encrypted store, reference it from configs instead of pasting it, never put it in a prompt or a tool argument, and rotate it on a schedule and whenever someone leaves.

## When you want OAuth

- **The server holds per-person data.** Mail, calendars, tickets, repositories. With a shared key, an agent run by Alice can read Bob's data. With a per-user token, it sees only what Alice may see.
- **Many people use the same agent.** One person leaving should mean revoking one grant, not rotating a key that every workflow depends on.
- **The server's audit log should name a person.** A key makes every call look like the same account.
- **The server is someone else's.** A hosted server that follows the MCP authorization specification asks for OAuth, and its consent screen shows the user what they are granting.
- **You need to widen access later.** OAuth bearer tokens have a defined way to say "not enough": a `403` with `error="insufficient_scope"` and the scopes needed (RFC 6750, section 3.1). MCP builds step-up authorization on it, and the 2026-07-28 revision has the client ask for the union of the scopes it already had and the challenged ones, so it does not drop scopes it already had.

## How they combine

Most real setups use both, at different hops. A useful rule is one credential per hop:

```text
IDE agent ── per-client token ──▶ MCP gateway ── OAuth token (per user) ──▶ hosted ticket server
                                             └─ API key (service account) ──▶ internal metrics server
```

The client's token is never forwarded. Each hop gets its own credential, held by the side that makes the call. That keeps the ban on passthrough, and it lets you choose OAuth where a person's data is involved and a key where a service account is the honest answer. [Least privilege for AI agents](/learn/security/least-privilege-for-agents) covers how to keep each of those credentials small.

## In L2M

L2M is a client toward the servers your agents call, and optionally a server toward MCP clients through its gateway. All of these are configured per server; a server with no auth needs none of it.

**API keys and other static credentials.** A registered HTTP server picks an auth type: `none`, `bearer`, `basic` or `oauth`. For `bearer`, the token comes from a secret in the Secrets store and goes out as `Authorization: Bearer <token>`. Secrets are encrypted at rest with AES-256-GCM, and configs store only a <Term id="secret-reference">secret reference</Term>; the API never returns the value ([Secrets](/security/secrets)). A stdio server gets its secret as an environment variable named by `secretEnvVar`, for example `TICKETS_API_KEY`.

**OAuth.** A server registered with auth type **OAuth** is connected once by an admin from the server page, with the flow in [MCP authorization](/learn/mcp/authorization#how-l2m-handles-it): PKCE, the `resource` parameter, a check of the response's `iss` when present, and refresh before expiry. For the comparison, three points matter:

- **Where the client id comes from.** A client id you entered is used first. Otherwise L2M offers its client metadata document, if you turned that on (`MCP_OAUTH_CLIENT_METADATA_ENABLED`, off by default), the redirect base is a public `https` URL, and the authorization server says it supports them. Otherwise it registers itself with dynamic client registration. See [OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers).
- **Tokens are handled like keys, only stricter.** They are stored only as encrypted internal secrets, never shown, returned by the API or written to logs, and they cannot be picked as a node's secret.
- **OAuth needs the registry.** It is only available for servers in the registry, not for an inline MCP Tool node, while a bearer key works on both.

**Per-user tokens.** By default an OAuth server has one shared connection. An admin can set **Credentials** to **Each user's own account** ([delegated credentials](/product/mcp-server-registry#delegated-credentials)). People then connect under **My connections**, and a run started by Alice uses Alice's token. A gateway call uses the connection of the calling client's owner. Runs with no person behind them (webhooks, schedules, the queue) fail unless an admin allows them to use the workflow owner's connection. A missing connection never falls back to a shared credential, and this mode requires OAuth: a delegated server with any other auth type is refused.

**The gateway side.** Clients that call L2M's [MCP gateway](/product/mcp-gateway) use a per-client token, not OAuth. The token is shown once and stored only as a SHA-256 hash. It can expire after 30 days, 90 days or a year, or never; it can be rotated with a grace window (24 hours by default) and revoked at once. When a gateway call reaches a registered server, L2M uses the credential the registry holds for that server (for a per-user server, the connection of the client's owner), never the client's token.

## Further reading

- [MCP specification 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (modelcontextprotocol.io): step-up authorization
- [RFC 6750: Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750) (IETF): the `insufficient_scope` error
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html) (IETF)
- [The OAuth 2.1 Authorization Framework](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) (IETF Internet-Draft)
- Related guides: [MCP authorization](/learn/mcp/authorization), [MCP hosts, clients and servers](/learn/mcp/hosts-clients-servers), [MCP security risks](/learn/security/mcp-security-risks), [MCP vs REST APIs](/learn/mcp/mcp-vs-rest-api)
