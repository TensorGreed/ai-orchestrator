---
title: "Toolset: a named group of MCP tools for a client"
term: "Toolset"
topic: mcp
definition: "A named, curated group of tools, drawn from several MCP servers and workflows, served at one MCP endpoint so each client sees only the tools it needs."
description: "A toolset groups tools and workflows into one MCP endpoint so each client sees only what it needs. Why it beats one big server."
related: [mcp-gateway, least-privilege, mcp-tool-policy, context-window]
guide: [/learn/operations/llm-gateway-vs-mcp-gateway]
---

# Toolset

**A named, curated group of tools, drawn from several MCP servers and workflows, served at one MCP endpoint so each client sees only the tools it needs.**

"Toolset" is not a term from the MCP specification. It is a gateway idea: instead of connecting a client to every server, or publishing one endpoint with every tool, you publish several small endpoints, each cut to one purpose. To the client, a toolset is just an MCP server with a short `tools/list`.

Why that beats one big server:

- **Less to misuse.** A support agent's endpoint holds the support tools, not the database admin tools the same upstream server also offers. That is <Term id="least-privilege">least privilege</Term> applied to the tool list.
- **Fewer wrong picks and fewer tokens.** An agent usually sends its tool definitions to the model with every request, where they use part of the <Term id="context-window">context window</Term>. A short list is cheaper, and easier for the model to choose from, than a long one. See [too many tools](/learn/agents/too-many-tools).
- **One credential per purpose.** A client's token can be limited to the toolsets it may call, and revoking it affects nothing else.

## Example

A team defines two toolsets on one gateway:

| Toolset | Members | Used by |
|---|---|---|
| `support` | the tracker server's `read_*` tools, a "refund request" workflow | the support chat agent |
| `eng` | the Git server's tools, the docs search server | IDE agents |

The IDE agents never see the refund workflow, and the support agent never sees `delete_branch`.

## Common confusion

A toolset is not a security rule. It decides what a client is shown, not what each call may do. Rules on arguments, approvals and roles still belong in a [tool policy](/product/mcp-tool-policy) that checks every call.

## In L2M

In the [MCP gateway](/product/mcp-gateway#toolsets), a toolset is served at `/mcp/<slug>`. Members are workflows with an **Expose as MCP Tool** trigger and registered servers, each narrowed with an optional tool glob such as `read_*`; server tools are named `<server-slug>__<tool>`. Each [client](/product/mcp-gateway#clients) token lists the toolsets it may call, and a toolset can name the project whose <Term id="mcp-tool-policy">tool policy</Term> applies.

## Further reading

- [MCP specification 2025-11-25: tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org)
