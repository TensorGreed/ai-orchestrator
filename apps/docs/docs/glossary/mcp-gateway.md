---
title: "MCP gateway: one governed endpoint for tools"
term: "MCP gateway"
topic: mcp
definition: "A service that sits between MCP clients and MCP tools and serves them through one endpoint, adding per-client credentials, access rules, limits and a log of every call."
description: "An MCP gateway serves many tools behind one endpoint with per-client credentials, tool rules and logs. What it adds over connecting servers directly."
related: [model-context-protocol, mcp-server, toolset, llm-gateway, mcp-tool-policy, least-privilege]
guide: [/learn/operations/llm-gateway-vs-mcp-gateway]
---

# MCP gateway

**A service that sits between <Term id="mcp-client">MCP clients</Term> and MCP tools and serves them through one endpoint, adding per-client credentials, access rules, limits and a log of every call.**

Without a gateway, every client connects to every server directly. Each IDE, assistant and agent holds its own copy of each server's credentials, and nobody has one view of which tool was called, by whom, with what arguments. A gateway turns that many-to-many wiring into one place to govern it. To a client, the gateway is an ordinary MCP server; to the servers behind it, the gateway is the client.

## What a gateway usually adds

- **Per-client credentials.** Each client gets its own token, which can be revoked without touching the others. Upstream server secrets stay in the gateway.
- **A narrower tool list.** A client sees only the tools it needs, not everything every server offers.
- **Rules on calls.** Allow, deny or hold a call for approval, by tool, client or arguments.
- **Limits and records.** Rate limits, spend caps and a log of each call.

## Example

A team gives its coding agents one endpoint with `search_docs`, `read_ticket` and a deploy workflow. The deploy tool needs an approval; the agents never see the database admin tools the same server also offers.

## Common confusion

An MCP gateway governs tool calls. An <Term id="llm-gateway">LLM gateway</Term> governs model calls (prompts and completions to model providers). They often sit side by side and can share client identities, but they inspect different traffic. A gateway must also avoid acting as a <Term id="confused-deputy">confused deputy</Term>: the MCP security best practices forbid a server from passing a client's token through to a downstream API.

## In L2M

The [MCP gateway](/product/mcp-gateway) serves workflows and registered servers' tools in <Term id="toolset">toolsets</Term> at `/mcp/<slug>`, each client with its own token. Optionally, add [tool policy](/product/mcp-tool-policy) rules, [budgets](/product/budgets) and rate limits. See also [Run a self-hosted MCP gateway](/guides/self-hosted-mcp-gateway).

## Further reading

- [MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) (modelcontextprotocol.io)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org)
