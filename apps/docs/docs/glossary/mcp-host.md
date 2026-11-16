---
title: "MCP host: the app that runs MCP clients"
term: "MCP host"
topic: mcp
definition: "The AI application, such as a chat app, an IDE or an agent runtime, that creates MCP clients, connects them to servers and decides what the model may use."
description: "The MCP host is the AI app (chat app, IDE, agent runtime) that creates MCP clients, holds the conversation and decides what the model may use."
related: [mcp-client, mcp-server, model-context-protocol, human-in-the-loop, tool-shadowing]
guide: [/learn/mcp/hosts-clients-servers]
---

# MCP host

**The AI application, such as a chat app, an IDE or an agent runtime, that creates MCP clients, connects them to servers and decides what the model may use.**

MCP has three roles. The host is the one a person actually uses. It owns the model, the full conversation and every consent decision. For each server it wants to use, it creates one <Term id="mcp-client">MCP client</Term>, a connection to exactly one <Term id="mcp-server">server</Term>. Among the host's jobs, the 2025-11-25 architecture page lists that it "Creates and manages multiple client instances", "Enforces security policies and consent requirements", "Handles user authorization decisions", "Coordinates AI/LLM integration and sampling" and "Manages context aggregation across clients".

The last job matters most for safety. One design principle of the protocol is that servers "should not be able to read the whole conversation, nor "see into" other servers". Only the host sees everything, so only the host can decide that data from one server may flow into a call to another.

## Example

A coding assistant in an IDE is connected to a git server and an issue tracker. The IDE is the host and runs two clients. When the model asks to call `create_issue` with a summary of a diff, the host:

1. checks whether that tool is allowed at all, and shows its arguments to the developer;
2. sends the call through the issue tracker's client only;
3. adds the result to the conversation, which the git server never sees.

If the issue tracker server then asks for user input (<Term id="elicitation">elicitation</Term>) or for a model call (<Term id="sampling">sampling</Term>), the request arrives on its client, but the host decides whether a person sees it and which model answers.

## Common confusion

People often call a whole chat app "an MCP client". As shorthand that is fine, but the specification splits the duties: protocol rules (versions, headers, token audience) belong to the client connection, while consent screens, approvals and choosing the model belong to the host. A host is also not a server: a gateway can be both, serving tools to its callers while acting as a host with its own clients toward upstream servers.

## In L2M

In a workflow, the [Agent Orchestrator and Supervisor nodes](/runtime/agent-loop#attachment-ports) play the host: the node holds the conversation, uses the model on its `chat_model` port and offers the model the tools of the MCP Tool nodes on its `tool` port. Host decisions are where L2M's controls sit, all optional: [tool policy](/product/mcp-tool-policy) hides tools before the model sees them or holds a call for approval, a server's elicitation form goes to a person in runs someone is watching and is declined in unattended runs, and sampling stays off until an admin allows it per server ([MCP server registry](/product/mcp-server-registry#sampling-a-server-asks-the-model-for-a-completion)). The [MCP gateway](/product/mcp-gateway) is L2M in the server role.

## Further reading

- [MCP specification 2025-11-25: architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
