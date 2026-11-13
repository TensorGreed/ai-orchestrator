---
title: "MCP server: what it is and what it exposes"
term: "MCP server"
topic: mcp
definition: "A program that offers tools, resources or prompts to AI applications over the Model Context Protocol, locally over stdio or remotely over HTTP."
description: "An MCP server exposes tools, resources and prompts to AI apps over stdio or HTTP. Examples, local vs remote servers, and the risks of running one."
related: [model-context-protocol, mcp-tool, mcp-client, stdio-transport, streamable-http, tool-poisoning]
guide: [/learn/mcp/hosts-clients-servers, /learn/mcp/what-is-mcp]
---

# MCP server

**A program that offers tools, resources or prompts to AI applications over the Model Context Protocol, locally over <Term id="stdio-transport">stdio</Term> or remotely over HTTP.**

A server wraps one system, such as a file system, a database, a ticket tracker or a search API, and describes what it offers in a form any <Term id="mcp-client">MCP client</Term> understands. The client asks for the list (`tools/list`, `resources/list`, `prompts/list`) and then calls or reads what it needs.

## Local and remote servers

- **Local (stdio).** The client starts the server as a child process and talks to it over standard input and output. Simple, and only that client can reach it, but the server runs with the user's own rights.
- **Remote (Streamable HTTP).** The server runs as a web service, often for many users. It needs authentication; the MCP authorization spec builds on OAuth 2.1 for this.

## Example

A Postgres MCP server might expose a read-only `query` tool, a resource per table schema, and a prompt "explain this query". An agent connected to it can answer questions about the data without any database code in the agent itself.

## Risks

A server is code you run or trust. The MCP security best practices warn that local servers can execute arbitrary commands with the client's privileges, and recommend showing the exact start command, asking for consent and sandboxing the process. A remote server's tool descriptions and results reach your model as text, which opens the door to <Term id="tool-poisoning">tool poisoning</Term> and <Term id="indirect-prompt-injection">indirect prompt injection</Term>.

## In L2M

Register a server once in the [MCP server registry](/product/mcp-server-registry): L2M probes its health on a schedule, keeps a history of its tool schemas, flags breaking changes, and can run stdio servers in a sandbox. L2M can also act as an MCP server itself, through the [MCP gateway](/product/mcp-gateway).

## Further reading

- [MCP specification 2025-11-25: architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) (modelcontextprotocol.io)
