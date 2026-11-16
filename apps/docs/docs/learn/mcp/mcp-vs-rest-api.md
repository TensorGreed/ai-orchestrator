---
title: "MCP vs REST APIs: when an agent needs a protocol"
sidebarTitle: "MCP vs REST APIs"
description: "Why agents use MCP instead of calling REST APIs directly: discovery, schemas, auth and sessions compared, and when a plain HTTP tool is the better choice."
level: beginner
about: model-context-protocol
related: [model-context-protocol, mcp-server, mcp-tool, tool-calling, least-privilege, ssrf]
---

# MCP vs REST APIs

A REST API is a service's own interface: many URLs and HTTP methods, designed for programs that a developer writes after reading the documentation. The <Term id="model-context-protocol">Model Context Protocol</Term> (MCP) is one fixed interface for AI applications: a client asks any server "which tools do you have?" (`tools/list`) and "run this one with these arguments" (`tools/call`), and gets back descriptions written for a model. They are not rivals. Most MCP servers that talk to a SaaS product call its REST API underneath. The real choice for an agent is how it reaches that API: through a generic HTTP tool, through a narrow tool you wrap yourself, or through an MCP server.

## The same API, two ways in

<figure>
<svg viewBox="0 0 660 230" role="img" aria-labelledby="rest-fig-title rest-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:660px">
  <title id="rest-fig-title">An agent reaching a REST API directly or through an MCP server</title>
  <desc id="rest-fig-desc">On the top path the agent uses a generic HTTP tool and builds the method, URL, headers and body itself before calling the REST API. On the bottom path the agent calls a named MCP tool with a few arguments, and the MCP server builds the HTTP request with its own credential.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="90" width="120" height="50" rx="8" fill="none" stroke="currentColor"/>
    <text x="80" y="120" text-anchor="middle">Agent</text>
    <rect x="230" y="20" width="170" height="50" rx="8" fill="none" stroke="currentColor"/>
    <text x="315" y="42" text-anchor="middle">Generic HTTP tool</text>
    <text x="315" y="60" text-anchor="middle" font-size="11">method, URL, headers, body</text>
    <rect x="230" y="160" width="170" height="50" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="315" y="182" text-anchor="middle">MCP server</text>
    <text x="315" y="200" text-anchor="middle" font-size="11">create_ticket(title, body)</text>
    <rect x="500" y="90" width="140" height="50" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="120" text-anchor="middle">REST API</text>
    <path d="M140 105 L230 50" stroke="currentColor" fill="none"/>
    <path d="M140 125 L230 180" stroke="currentColor" fill="none"/>
    <path d="M400 45 L500 105" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
    <path d="M400 185 L500 125" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
    <text x="470" y="62" text-anchor="middle" font-size="11">model built it</text>
    <text x="470" y="182" text-anchor="middle" font-size="11">server built it</text>
  </g>
</svg>
<figcaption>Both paths end at the same REST API. What changes is who writes the HTTP request: the model, or code that someone reviewed.</figcaption>
</figure>

## Side by side

| Question | REST API | MCP |
| --- | --- | --- |
| Who is it designed for? | Developers writing client code | AI applications that list and call tools at run time |
| How many operations does a caller learn? | Every endpoint, method, header and status code of that API | Two core methods for tools, the same on every server |
| How is it described? | Optionally by an OpenAPI document, read at build time | By `tools/list` at run time: a `name`, a `description` and an `inputSchema` per tool |
| Who reads the description? | A developer | The model, directly |
| How do errors come back? | HTTP status codes and an API-specific body | A protocol error, or a tool result with `isError: true` and a message the model can act on |
| How does auth work? | Whatever the API chose: API keys, OAuth, signed requests | For HTTP servers, an OAuth 2.1 based flow the spec defines; for local stdio servers, credentials from the environment |
| How does a caller learn about changes? | Release notes and version numbers | `notifications/tools/list_changed` from servers that declare `listChanged` |
| What carries it? | HTTP | JSON-RPC 2.0 over stdio or Streamable HTTP |

The OpenAPI Specification calls itself "a standard, language-agnostic interface to HTTP APIs which allows both humans and computers to discover and understand the capabilities of the service". That is close to what MCP's `tools/list` does. The difference is the reader and the moment. An OpenAPI document describes every operation of an API for code generators and developers. An MCP tool list is a short menu, written for a model, served at the moment the agent needs it.

## Why not let the agent call the REST API directly?

You can give a model a tool such as `http_request(method, url, headers, body)` and point it at any API. It works in a demo. In production, four things go wrong.

1. **The action surface is the whole API.** A generic HTTP tool lets the model call any endpoint with any method. A `DELETE` is one token away from a `GET`. With an MCP server, or a narrow tool you write, the model can only call `search_tickets` and `create_ticket`, and each has a schema that rejects extra fields.
2. **The credential has to go somewhere.** If the model builds the headers, the API key ends up in its context or in its tool arguments, where traces and logs can capture it. An MCP server holds its own credential and adds it itself. The model never sees it. See [OAuth vs API keys for MCP](/learn/security/oauth-vs-api-keys-for-mcp).
3. **Any URL is reachable.** A tool that fetches whatever URL the model writes is a request-forgery risk: a prompt injection in a document can steer it to an internal address or to an attacker's server with your data in the query string. See <Term id="ssrf">SSRF</Term> and [the lethal trifecta](/learn/security/lethal-trifecta).
4. **The model reads API docs badly at run time.** Long endpoint lists, pagination rules and status codes cost tokens and invite wrong calls. A few well-named tools with short descriptions work better. See [Too many tools](/learn/agents/too-many-tools).

None of this needs MCP specifically. A hand-written function with a fixed URL and a narrow schema solves the same problems. MCP adds that the narrow tool is packaged once, as a server, and every MCP-capable app can use it.

## When a plain HTTP call is the better choice

Not every API call needs a model to decide it, and not every call needs a protocol.

- **The call is fixed.** "When a form is submitted, post it to the CRM" is a workflow step. No model chooses anything, so a plain HTTP request with a reviewed URL template is simpler and cheaper.
- **There is one endpoint, and it is yours.** Wrapping your own internal service in an MCP server just to call one route adds a process to run and monitor.
- **The data is large or binary.** Moving a file between two systems is better done by a step that streams it than by a model reading it as a tool result.
- **Latency matters.** Every tool call an agent makes costs at least one more model call to read the result. A fixed step costs none.

A good rule: if the model must decide **whether** and **with what arguments** to call, give it a narrow tool (MCP or your own function). If nothing needs deciding, use a plain HTTP step.

## How they combine

The usual architecture uses both, in layers:

- **An MCP server wraps a REST API.** The server picks the operations an agent needs, names them clearly, writes short descriptions, holds the API credential and returns compact results. The REST API is unchanged.
- **OpenAPI as a starting point.** An OpenAPI document already lists operations with a unique `operationId` and their parameters, so some teams generate MCP tools from it. Generate, then cut: an API with eighty operations should not become eighty tools.
- **Fixed calls stay plain HTTP.** Steps that always happen, such as logging a result or sending a webhook, stay outside the agent.

## In L2M

L2M has both paths, and keeps them apart:

- **The HTTP Request node** is a workflow step: a method (`GET`, `POST`, `PUT`, `PATCH` or `DELETE`), a URL template, a headers template, a body template and an optional secret, which L2M sends as `Authorization: Bearer <secret>`. The secret is stored encrypted and the workflow holds only a reference to it ([secrets](/security/secrets)). Its URL goes through [outbound URL checks](/security/outbound-url-checks), which always block cloud metadata addresses and can block private ranges. It is not attached to an agent's `tool` port, so a model never writes its URL.
- **MCP Tool nodes** on an agent's `tool` port are the agent's tools. Register each server once in the [MCP server registry](/product/mcp-server-registry), with its endpoint and credential, and pick the tools an agent may see.
- **A narrow tool from your own HTTP call.** To let an agent decide when to call a REST endpoint without writing an MCP server, put the HTTP Request node in a small workflow and attach that workflow to the agent with a [Workflow Tool](/runtime/workflow-tool) node. The agent sees one tool whose arguments come from the child workflow's trigger (its input schema, or one free-text `input`), and the URL and secret stay in the child. Workflow tools are governed like MCP tools: tool rules can deny them or require approval, and each call is recorded in tool-call telemetry.

The reverse also works. An **Expose as MCP Tool** trigger turns a whole workflow, HTTP calls included, into an MCP tool that other agents call through the [MCP gateway](/product/mcp-gateway) ([workflow as an MCP tool](/runtime/workflow-as-mcp-tool)).

## Further reading

- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [OpenAPI Specification 3.1.0](https://spec.openapis.org/oas/v3.1.0.html) (OpenAPI Initiative)
- Related guides: [What is MCP?](/learn/mcp/what-is-mcp), [MCP vs function calling](/learn/mcp/mcp-vs-function-calling), [MCP tools, resources and prompts](/learn/mcp/tools-resources-prompts)
