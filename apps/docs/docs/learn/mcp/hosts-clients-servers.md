---
title: "MCP hosts, clients and servers: who does what"
sidebarTitle: "Hosts, clients and servers"
description: "The three MCP roles in plain terms: what the host app, each client connection and each server own, local vs remote servers, and where credentials live."
level: beginner
about: mcp-host
related: [mcp-host, mcp-client, mcp-server, stdio-transport, streamable-http, toolset]
---

# MCP hosts, clients and servers: who does what

In the Model Context Protocol, the <Term id="mcp-host">host</Term> is the AI application a person actually uses: it owns the conversation, the model and every decision about consent. Inside the host, an <Term id="mcp-client">MCP client</Term> is one connection to one server, and nothing more. An <Term id="mcp-server">MCP server</Term> is a separate program that offers tools, resources and prompts, either as a process on the same machine or as a service on the network. When you wonder who is responsible for something, the answer is usually the host.

## The three roles

The 2025-11-25 architecture page calls MCP a "client-host-server architecture where each host can run multiple client instances". Each role has a short list of jobs:

| Role | What it is | What it owns | What it should not see |
|---|---|---|---|
| Host | The application: a desktop chat app, an IDE, an agent runtime | The model, the full conversation, user consent, which servers are connected | Nothing is hidden from it |
| Client | One connection object inside the host | Protocol negotiation and the message traffic with its one server | Other servers' traffic |
| Server | A program that wraps one system, such as a file tree, a database or a ticket API | Its own tools, resources and prompts, and its own access to the system behind it | The whole conversation and the other servers |

The specification's own bullet lists are worth reading in full, because they assign the hard jobs clearly. The host "Enforces security policies and consent requirements", "Handles user authorization decisions" and "Manages context aggregation across clients". The client "Establishes one stateful session per server" and "Maintains security boundaries between servers". The server "Can be local processes or remote services".

A concrete case: a developer's IDE has a coding assistant connected to a git server on the laptop and to the company's issue tracker on the network. The IDE is the host. It runs two clients. The git server and the issue tracker server are the two servers. When the model wants to open an issue, the host decides whether to ask the developer first; the issue tracker server only receives the `tools/call` request with its arguments.

## One host, many clients

The host creates a separate client for every server, and the specification says each client has "a 1:1 relationship with a particular server". This is not an implementation detail. It is how MCP keeps servers apart.

One of the protocol's design principles reads: "Servers should not be able to read the whole conversation, nor "see into" other servers". Under it the specification lists "Full conversation history stays with the host" and "Cross-server interactions are controlled by the host". So if the git server's output should inform a call to the issue tracker, the host (usually through its model) carries that information across. The issue tracker server never talks to the git server.

Each connection also agrees its own capabilities. In the 2025-11-25 revision that happens in the `initialize` handshake: the server says which features it has (tools, resources, prompts, list-change notifications) and the client says which it supports (sampling, elicitation, roots). One server can offer only tools while its neighbour offers resources and prompts too. Both sides must stay within what they declared.

The 2026-07-28 revision keeps the three roles and changes how a connection starts. The `initialize` handshake is gone. Every request now carries its protocol version and client capabilities in `_meta`, and servers must answer a `server/discover` request that advertises their versions, capabilities and identity. A client is still one connection to one server; it just no longer holds a protocol session open. [MCP transports](/learn/mcp/transports) covers what that means on the wire.

Two points often confuse people:

- **"The MCP client" in everyday speech.** People call a whole chat app or IDE "an MCP client". That is fine as shorthand, but when a security rule in the specification puts a duty on a client or a host, check which one it means. Consent screens and approvals belong to the host.
- **One program, two roles.** Nothing stops a program from being a server toward one side and a host with its own clients toward the other. A gateway or proxy works this way: it serves tools to callers and calls other servers to fulfil them. The rules for each side still apply separately.

## Local servers and remote servers

A server runs in one of two places, and the place decides the transport, the risks and how it gets credentials.

| | Local server | Remote server |
|---|---|---|
| Transport | <Term id="stdio-transport">stdio</Term>: the host starts it as a child process | <Term id="streamable-http">Streamable HTTP</Term>: an HTTP endpoint |
| Who can reach it | Only the client that started it | Anyone who can reach the endpoint and authenticate |
| Runs as | The same user and privileges as the host | Wherever its operator runs it, with the operator's own access |
| Credentials | Read from its environment | OAuth access token, or another HTTP credential |
| Typical use | Files, local git, a developer database | A shared ticket system, a SaaS API, a company knowledge base |

A local server is code running on your machine. The MCP security best practices list the risk plainly: "Arbitrary code execution. Attackers can execute any command with MCP client privileges." Their mitigations are aimed at the host. If a client lets people add a local server in one click, it MUST "Show the exact command that will be executed, without truncation" and "Require explicit user approval before proceeding", and it SHOULD start the server "in a sandboxed environment with minimal default privileges". The same page recommends that a server meant to run locally use stdio "to limit access to just the MCP client", because nothing then listens on a port.

A remote server lives behind a URL, serves many clients, and has to authenticate each one. That is where the OAuth-based authorization specification comes in. It also means the server operator, not you, controls the code: it can change its tools between one call and the next.

## Where your credentials live

There are usually two different credentials in play, and mixing them up causes most of the security mistakes people make with MCP.

**1. The credential the client uses to reach the server.** For a remote server, the authorization specification makes the MCP server an OAuth 2.1 resource server and the MCP client an OAuth 2.1 client. The client runs the sign-in on the host's behalf, the host keeps the resulting token, and the client sends it on every request. For a local server there is no OAuth at all: implementations using stdio "SHOULD NOT follow this specification, and instead retrieve credentials from the environment". In practice the host passes an API key to the child process as an environment variable.

**2. The credential the server uses to reach the system behind it.** A ticket server needs its own access to the ticket API. That credential belongs to the server. The authorization specification is explicit that the server may not reuse the client's token for this: "The MCP server **MUST NOT** pass through the token it received from the MCP client." Forwarding it anyway is called <Term id="token-passthrough">token passthrough</Term>, and the security best practices forbid it because the downstream API can no longer tell who is calling or apply its own controls.

A few consequences follow:

- **The model never holds a credential.** It only names a tool and its arguments. The host's client attaches the token; the server uses its own key downstream. A credential that appears in a prompt or a tool result has leaked.
- **Store tokens like passwords.** The authorization specification says clients and servers "**MUST** implement secure token storage". For a host that runs on a server and serves many people, that means encrypted storage, not a config file.
- **Shared or per-person.** A host can use one service credential for every user, or let each person connect their own account so the server sees who is acting. The second option is often called <Term id="delegated-credentials">delegated credentials</Term>.
- **Never through a form.** A server can ask the person a question mid-call (elicitation), but the specification says servers "**MUST NOT** use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials".

[MCP authorization](/learn/mcp/authorization) walks through the OAuth flow step by step.

## L2M in both roles

L2M is a host with MCP clients when its agents call tools, and optionally a server when other MCP clients call it.

**As a host and client.** An Agent Orchestrator or Supervisor node is the host side: it holds the conversation, uses the chat model attached to its `chat_model` port, and its model sees the tools of the MCP Tool nodes attached to its `tool` port. Optionally, [tool policy](/product/mcp-tool-policy) removes denied tools before the model ever sees them. Each server is registered once in the [MCP server registry](/product/mcp-server-registry), which runs the client side:

- `http_mcp` connects to remote servers over Streamable HTTP, and `stdio_mcp` starts local servers as child processes.
- Credentials sit in L2M's Secrets store, encrypted at rest with AES-256-GCM, and configs hold only a reference to them ([secrets](/security/secrets)). For HTTP the registry entry picks an auth type: bearer token, basic or OAuth; for stdio, `secretEnvVar` names the environment variable that receives the secret.
- Optionally, an OAuth server can use each person's own account instead of one shared credential ([delegated credentials](/product/mcp-server-registry#delegated-credentials)). A call that needs a person's connection never falls back to the shared one.
- Optionally, a stdio server runs in a throwaway container with no network by default ([sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)).
- Out of the box, L2M's `initialize` request names protocol version `2025-06-18`. A server that turns that handshake down because it only knows 2026-07-28 still gets reached: L2M moves to 2026-07-28 for it. Asking for 2026-07-28 first is opt-in.

**As a server.** The [MCP gateway](/product/mcp-gateway) serves <Term id="toolset">toolsets</Term> at `POST /mcp/<toolset>` over Streamable HTTP. A toolset can hold workflows, each turned into one tool by an **Expose as MCP Tool** trigger ([workflow as an MCP tool](/runtime/workflow-as-mcp-tool)), and tools of registered servers re-exposed under names like `github__create_issue`. Each calling client gets its own token, which L2M stores only as a hash. When a gateway call reaches a registered server, L2M uses that server's credential from the registry (or, with delegated credentials, the connection of the person who owns the calling client), never the caller's token. The gateway offers tools only; it does not serve resources or prompts. Callers on 2025-11-25, 2025-06-18 or 2025-03-26 work with no setup; accepting 2026-07-28 callers too is opt-in, with `MCP_GATEWAY_MODERN_PROTOCOL=on`.

Put together, the roles can chain:

```text
IDE (host) ── client + token ──▶ L2M gateway /mcp/support        L2M as a server
                                   └─ workflow tool runs a workflow
                                        └─ Agent node (host) ── client ──▶ ticket server   L2M as a client
```

The IDE never sees the ticket server's credential, and the ticket server never sees the IDE's token. Each hop has its own credential. To build the top half with no API key, follow the [workflow as an MCP tool recipe](/recipes/workflow-as-mcp-tool).

See also: [MCP security risks](/learn/security/mcp-security-risks), for the attacks that target each of these roles.

## Further reading

- [MCP specification, 2025-11-25: Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- In L2M: [MCP gateway](/product/mcp-gateway), [MCP server registry](/product/mcp-server-registry), [workflow as an MCP tool](/runtime/workflow-as-mcp-tool)
