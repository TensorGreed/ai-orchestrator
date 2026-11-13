---
title: "What is the Model Context Protocol (MCP)?"
sidebarTitle: "What is MCP?"
description: "MCP explained: hosts, clients and servers, the tools, resources and prompts a server offers, how a tool call travels, and a runnable agent to try."
level: beginner
about: model-context-protocol
demo: wf-demo-support-agent
demoRecorded: true
related: [model-context-protocol, mcp-server, mcp-client, mcp-host, mcp-tool, tool-calling]
socialCard: true
---

# What is the Model Context Protocol (MCP)?

The <Term id="model-context-protocol">Model Context Protocol</Term> (MCP) is an open standard for connecting AI applications to tools and data. A program called an <Term id="mcp-server">MCP server</Term> offers tools, resources and prompts; an AI application connects to it as an <Term id="mcp-client">MCP client</Term>, lists what it offers and calls it with JSON-RPC messages. Write a server once, and MCP-capable apps and agents can use it.

## The problem it solves

Before a shared protocol, every pairing of an AI app and a tool needed its own glue code. Ten apps and twenty tools could mean up to two hundred small integrations, each with its own way of describing arguments, returning errors and handling credentials.

MCP turns that into one contract on each side. A tool author writes one MCP server. An app author writes one MCP client. Any client can then talk to any server, because both speak the same messages: "what do you offer?", "run this tool with these arguments", "here is the result".

That is the whole idea. MCP does not make models smarter. It makes tools portable.

## Hosts, clients and servers

The specification names three roles:

- The **host** is the AI application the person uses: a chat app, an IDE, or an agent runtime like L2M. It holds the conversation, talks to the model, and decides which servers to connect to and what the model may call.
- A **client** lives inside the host. The host creates one client per server, and each client keeps exactly one connection, so a host with three servers runs three clients.
- A **server** is a program that offers capabilities. It can run as a local process on the same machine, or as a remote service over HTTP.

<figure class="recipe-diagram">
<svg viewBox="0 0 680 300" role="img" aria-labelledby="mcp-roles-title mcp-roles-desc" xmlns="http://www.w3.org/2000/svg"><title id="mcp-roles-title">An MCP host with three clients, each connected to one server</title><desc id="mcp-roles-desc">The host application contains three MCP clients. Client 1 connects to a files server over stdio on the same machine. Client 2 connects to a database server over stdio. Client 3 connects to a remote server over Streamable HTTP.</desc><defs><marker id="mcp-roles-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><g class="rd-node" data-kind="agent"><rect x="20" y="20" width="250" height="260" rx="12"/></g><text class="rd-name" x="36" y="46">Host (the AI app)</text><text class="rd-type" x="36" y="64">holds the chat, calls the model</text><g class="rd-node" data-kind="step" transform="translate(50 86)"><rect width="190" height="46" rx="10"/><text class="rd-name" x="12" y="28">MCP client 1</text></g><g class="rd-node" data-kind="step" transform="translate(50 152)"><rect width="190" height="46" rx="10"/><text class="rd-name" x="12" y="28">MCP client 2</text></g><g class="rd-node" data-kind="step" transform="translate(50 218)"><rect width="190" height="46" rx="10"/><text class="rd-name" x="12" y="28">MCP client 3</text></g><path class="rd-edge" d="M240 109 L438 109" marker-end="url(#mcp-roles-arrow)"/><path class="rd-edge" d="M240 175 L438 175" marker-end="url(#mcp-roles-arrow)"/><path class="rd-edge" d="M240 241 L438 241" marker-end="url(#mcp-roles-arrow)"/><text class="rd-type" x="262" y="101">stdio</text><text class="rd-type" x="262" y="167">stdio</text><text class="rd-type" x="262" y="233">Streamable HTTP</text><g class="rd-node" data-kind="tool" transform="translate(440 86)"><rect width="220" height="46" rx="10"/><text class="rd-name" x="12" y="20">Files server</text><text class="rd-type" x="12" y="37">local process</text></g><g class="rd-node" data-kind="tool" transform="translate(440 152)"><rect width="220" height="46" rx="10"/><text class="rd-name" x="12" y="20">Database server</text><text class="rd-type" x="12" y="37">local process</text></g><g class="rd-node" data-kind="tool" transform="translate(440 218)"><rect width="220" height="46" rx="10"/><text class="rd-name" x="12" y="20">Ticketing server</text><text class="rd-type" x="12" y="37">remote service</text></g></svg>
<figcaption>One host, one client per server. Servers are not meant to see each other or the whole conversation: the host decides what each one receives.</figcaption>
</figure>

The split matters for security. The specification's design principles say servers should not be able to read the whole conversation or "see into" other servers. The host sits in the middle and keeps those boundaries.

## What a server offers: tools, resources, prompts

A server can offer three kinds of things. The specification separates them by who is in control:

| Primitive | Who controls it | What it is | Example |
|---|---|---|---|
| **Tools** | The model | Functions the model can ask to run | Create a ticket, query a table, write a file |
| **Resources** | The application | Data the app reads and attaches as context | A file's contents, a database schema |
| **Prompts** | The user | Templates the person picks | A "summarise this incident" command |

Tools get the most attention, because they are how an agent acts. An <Term id="mcp-tool">MCP tool</Term> has a name, a description and a JSON Schema for its input. It can also declare an output schema, and hints about its behaviour, such as whether it only reads. The specification tells clients to treat those hints as untrusted unless the server is trusted.

In the other direction, a client can offer features to the server. In the 2025-11-25 revision these are sampling (the server asks the client's model for a completion), elicitation (the server asks the person a question) and roots (the client tells the server which folders it may work in).

## A tool call, step by step

Here is what happens when an agent answers "What is the weather in New York?" with a weather server attached.

<figure class="recipe-diagram">
<svg viewBox="0 0 660 400" role="img" aria-labelledby="mcp-call-title mcp-call-desc" xmlns="http://www.w3.org/2000/svg"><title id="mcp-call-title">The messages of one MCP tool call</title><desc id="mcp-call-desc">The MCP client sends tools/list to the server and gets the tool list. It sends the messages and tool definitions to the model. The model asks for get_weather with a location. The client sends tools/call to the server and gets a result. The client gives the result to the model, which writes the final answer.</desc><defs><marker id="mcp-call-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><g class="rd-node" data-kind="model" transform="translate(30 16)"><rect width="150" height="44" rx="10"/><text class="rd-name" x="14" y="27">Model</text></g><g class="rd-node" data-kind="agent" transform="translate(255 16)"><rect width="150" height="44" rx="10"/><text class="rd-name" x="14" y="20">Host + client</text><text class="rd-type" x="14" y="36">the agent runtime</text></g><g class="rd-node" data-kind="tool" transform="translate(480 16)"><rect width="150" height="44" rx="10"/><text class="rd-name" x="14" y="27">MCP server</text></g><path class="rd-edge is-port" d="M105 60 L105 390"/><path class="rd-edge is-port" d="M330 60 L330 390"/><path class="rd-edge is-port" d="M555 60 L555 390"/><path class="rd-edge" d="M330 96 L552 96" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="442" y="89" text-anchor="middle">1. tools/list</text><path class="rd-edge" d="M555 130 L333 130" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="442" y="123" text-anchor="middle">tools: get_weather, …</text><path class="rd-edge" d="M330 172 L108 172" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="165" text-anchor="middle">2. messages + tool list</text><path class="rd-edge" d="M105 206 L327 206" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="199" text-anchor="middle">tool call: get_weather</text><path class="rd-edge" d="M330 248 L552 248" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="442" y="241" text-anchor="middle">3. tools/call</text><path class="rd-edge" d="M555 282 L333 282" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="442" y="275" text-anchor="middle">result (content)</text><path class="rd-edge" d="M330 324 L108 324" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="317" text-anchor="middle">4. tool result</text><path class="rd-edge" d="M105 360 L327 360" marker-end="url(#mcp-call-arrow)"/><text class="rd-type" style="paint-order:stroke;stroke:var(--vp-c-bg-soft);stroke-width:5px;stroke-linejoin:round" x="218" y="353" text-anchor="middle">final answer</text></svg>
<figcaption>The model never talks to the server. It only names a tool; the client makes the call.</figcaption>
</figure>

1. **Discover.** The client sends `tools/list`. The server answers with each tool's name, description and input schema.
2. **Offer.** The host sends the conversation and the tool definitions to the model, in whatever format that model's API uses for <Term id="tool-calling">tool calling</Term>.
3. **Call.** The model replies with a tool call instead of text: a tool name and arguments. The client turns that into a `tools/call` request:

   ```json
   {
     "jsonrpc": "2.0",
     "id": 2,
     "method": "tools/call",
     "params": { "name": "get_weather", "arguments": { "location": "New York" } }
   }
   ```

   The server runs the tool and returns content:

   ```json
   {
     "jsonrpc": "2.0",
     "id": 2,
     "result": {
       "content": [{ "type": "text", "text": "Current weather in New York:\nTemperature: 72°F\nConditions: Partly cloudy" }],
       "isError": false
     }
   }
   ```

4. **Answer.** The host adds the result to the conversation and calls the model again. The model now writes its answer, or asks for another tool.

Steps 2 to 4 repeat until the model stops asking for tools. That repetition is the agent loop, covered in [What is an AI agent?](/learn/agents/what-is-an-ai-agent).

**Two kinds of errors.** A tool that fails returns a normal result with `isError: true` and a message, such as "date must be in the future". The specification says clients should pass these to the model so it can correct itself and retry. Problems with the request itself, such as an unknown tool name, come back as JSON-RPC errors instead.

## Transports in one minute

MCP messages are JSON-RPC 2.0. A transport carries them. The specification defines two:

- **stdio.** The client starts the server as a child process and exchanges messages over its standard input and output. Good for local servers: nothing listens on the network.
- **Streamable HTTP.** The client sends each message as an HTTP POST to one endpoint. The server replies with JSON, or with a stream of server-sent events, for example to send progress before the result. This is the transport for remote servers.

An older HTTP-with-SSE transport from 2024 is deprecated. If a server's docs mention a separate SSE endpoint, that is the old style.

## What MCP does not do

MCP is a wire protocol. It leaves several things to the host:

- **Authorization is optional.** The specification defines an OAuth 2.1 flow for HTTP servers, but a server may skip it. Local stdio servers take credentials from their environment instead. See [MCP authorization](/learn/mcp/authorization).
- **No policy.** Nothing in the protocol says which user may call which tool, or with which arguments. The tools page says there SHOULD always be a human in the loop with the ability to deny tool invocations, and leaves the how to the application.
- **No audit or budget.** The specification suggests that clients log tool usage and time out slow calls, but it defines no log format, retention or spending cap.
- **No trust in tool descriptions.** A tool's description goes straight into the model's context. A malicious or careless server can put instructions there. Pick servers you trust, and pin their versions.

These gaps are where hosts and gateways differ most.

## Versions and how the spec changes

MCP versions are dates in the form `YYYY-MM-DD`: the last date a backwards-incompatible change was made. A client and a server must use a version they both support.

- **2025-11-25** is the previous revision. A connection starts with an `initialize` handshake that agrees the version and capabilities, and an HTTP server can keep a session with an `Mcp-Session-Id` header.
- **2026-07-28** is the current revision. It makes MCP stateless: the `initialize` handshake and protocol sessions are gone, and every request carries its own protocol version and client capabilities. A new `server/discover` request lets a client ask what a server supports up front. Server-to-client requests, such as asking the person a question, are replaced by a pattern where the server answers "input required" and the client retries the request with the answer. The revision also deprecates Roots, Sampling, Logging and OAuth dynamic client registration, and adopts a lifecycle policy that normally keeps a deprecated feature in the specification for at least twelve months.

Old and new revisions can work together: the 2026-07-28 specification describes how a client or server detects a handshake-era counterpart and falls back.

## MCP in L2M

L2M plays both roles:

- **As a host and client.** An Agent Orchestrator node calls MCP tools through MCP Tool nodes attached to its `tool` port. Servers run over Streamable HTTP or stdio, and an in-process mock server ships for trying things without setup. The [MCP server registry](/product/mcp-server-registry) keeps one entry per server, with health probes and the history of its tool schemas.
- **As a server.** The [MCP gateway](/product/mcp-gateway) serves workflows and registered tools to other MCP clients, such as an IDE agent, through <Term id="toolset">toolsets</Term> with a token per client.

On protocol versions: by default the gateway speaks 2025-11-25, 2025-06-18 and 2025-03-26, and when L2M connects to a server it asks for 2025-06-18. Support for 2026-07-28 is opt-in: with `MCP_GATEWAY_MODERN_PROTOCOL=on` the gateway also serves 2026-07-28 clients without sessions, and `MCP_CLIENT_PROTOCOL_DEFAULT` (or a server's own `protocolMode`) lets L2M talk to 2026-07-28 servers first. [MCP transports](/learn/mcp/transports) explains what changes on the wire.

The gaps listed above are covered by optional L2M features: [tool policy](/product/mcp-tool-policy) to allow, deny or require approval per tool, [approvals](/product/approvals) before write tools, and [tool-call telemetry](/product/mcp-tool-call-telemetry). A simple workflow needs none of them.

## Try it in L2M

The live demo has a support agent with two MCP tools on a small HTTP server: a knowledge-base lookup and a calculator. Its recorded run shows the full exchange: one `lookup_kb` call, then a calculator call that fails because the model passed words instead of digits (the server answers with `isError: true`; the trace shows its error message), then a retry with `49*12*12` that works. The run was recorded with a scripted stand-in model, so the demo needs no key.

To build one yourself with no API key, use the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) or the [five-minute tutorial](/getting-started/build-your-first-mcp-agent). Both use the built-in echo model, which never asks for a tool, so a local run stops after one model call. Attach a real chat model to watch tools get called.

## Further reading

- [MCP specification, 2025-11-25: Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [MCP specification: Versioning](https://modelcontextprotocol.io/specification/versioning) (modelcontextprotocol.io)
- [MCP integration in L2M](/extensions/mcp) and the [agent loop](/runtime/agent-loop)
