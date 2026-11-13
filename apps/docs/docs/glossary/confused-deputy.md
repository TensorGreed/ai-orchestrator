---
title: "Confused deputy problem in MCP and agents"
term: "Confused deputy"
topic: security
definition: "A program that holds more authority than its caller and is tricked into using that authority on the caller's behalf, doing something the caller could not do directly."
description: "A confused deputy acts with its own broad rights for a caller who should have fewer. How it shows up in MCP proxies and agents, and the fixes."
related: [token-passthrough, least-privilege, delegated-credentials, oauth-2-1]
guide: [/learn/security/mcp-security-risks]
---

# Confused deputy

**A program that holds more authority than its caller and is tricked into using that authority on the caller's behalf, doing something the caller could not do directly.**

The deputy is not malicious, only confused: it checks that a request is well formed, not whether this caller may make it, and then acts with its own rights. MCP setups have two common cases.

- **OAuth proxy servers.** An MCP server in front of a third-party API often uses one static OAuth client id for every user. The MCP security best practices show how an attacker registers a client, sends the user a crafted link, rides the consent cookie from the user's earlier login past the consent screen, and receives an authorization code meant for the user. The spec's fixes: per-client consent before forwarding (a MUST), exact redirect URI matching, and single-use `state` values set only after consent.
- **Agents with shared credentials.** OWASP's MCP cheat sheet describes the general case: "The MCP server executes actions with its own (often broad) privileges, not the requesting user's permissions." An agent is a deputy too, and <Term id="prompt-injection">prompt injection</Term> is a way to confuse it.

## Example

A help-desk agent reads customer records through an MCP server that holds an admin database token. Alice, a support agent for Europe, asks: "Summarise account 4471." Account 4471 is in the US region, which Alice may not see. The server checks the query, not Alice, and returns the record. Alice has borrowed the agent's authority.

The fix is to carry the caller into the call: run the tool with Alice's own credential, or check her rights before it runs.

## Common confusion

A confused deputy is not the same as <Term id="token-passthrough">token passthrough</Term>. Passthrough is one way to create the problem: the downstream API trusts a token as if the MCP server had vouched for it. A deputy can be confused with no token forwarding at all, simply by using its own broad credential.

## In L2M

For HTTP servers that use OAuth, an admin can optionally switch a registered server to [delegated credentials](/product/mcp-server-registry#delegated-credentials): each call then uses the signed-in user's own connection (or the gateway client owner's), never a shared fallback. [Tool policy](/product/mcp-tool-policy) can limit tools and arguments by role. L2M's own OAuth flow uses PKCE, single-use `state` and an issuer check ([OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers)).

## Further reading

- [MCP security best practices: confused deputy problem](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) (modelcontextprotocol.io)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org)
