---
title: "MCP vs A2A: tools vs agent-to-agent protocols"
sidebarTitle: "MCP vs A2A"
description: "MCP connects an agent to tools and data; A2A connects agents to other agents. What each protocol defines, where they overlap and how they combine."
level: intermediate
about: model-context-protocol
demo: wf-demo-research-swarm
demoRecorded: true
related: [model-context-protocol, mcp-tool, supervisor-agent, worker-agent, ai-agent]
---

# MCP vs A2A

The <Term id="model-context-protocol">Model Context Protocol</Term> (MCP) connects an AI application to tools and data: the application lists a server's tools and calls them, one request and one result at a time. The Agent2Agent protocol (A2A) connects one agent to another agent that it treats as an independent peer: the caller finds the remote agent through a published Agent Card, sends it a message, and usually follows a task that can run for a long time, ask for more input and produce artifacts. The A2A specification puts it plainly: "A2A and MCP are complementary protocols designed for different aspects of agentic systems." A tool is something your agent uses. A remote agent is something your agent asks. L2M implements MCP; it does not implement A2A.

## What sits on the other end

The quickest way to tell the two apart is to ask what the caller is talking to.

- **With MCP, a tool.** It has a name, a description and a JSON Schema for its input. You call it with arguments and get a result back. The MCP architecture keeps servers narrow: a server "should not be able to read the whole conversation, nor 'see into' other servers". The host, your agent, holds the context and decides.
- **With A2A, an agent.** It has its own model, its own tools and its own reasoning, which the caller does not see. A2A's goal is to let agents work together "without needing access to each other's internal state, memory, or tools". The caller describes what it wants in a message; the remote agent decides how to do it.

<figure>
<svg viewBox="0 0 660 240" role="img" aria-labelledby="a2a-fig-title a2a-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:660px">
  <title id="a2a-fig-title">A2A between agents, MCP between an agent and its tools</title>
  <desc id="a2a-fig-desc">A client agent on the left uses MCP to call its own tool server. It uses A2A to send a task to a remote agent in another system. The remote agent uses MCP to call its own tool servers, which the client agent never sees.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="90" width="150" height="54" rx="8" fill="none" stroke="currentColor"/>
    <text x="95" y="114" text-anchor="middle">Client agent</text>
    <text x="95" y="132" text-anchor="middle" font-size="11">your system</text>
    <rect x="20" y="186" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="95" y="211" text-anchor="middle">Its MCP server</text>
    <rect x="300" y="90" width="150" height="54" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="375" y="114" text-anchor="middle">Remote agent</text>
    <text x="375" y="132" text-anchor="middle" font-size="11">another system</text>
    <rect x="500" y="40" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="65" text-anchor="middle">MCP server</text>
    <rect x="500" y="154" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="179" text-anchor="middle">MCP server</text>
    <path d="M95 144 L95 186" stroke="currentColor" fill="none"/>
    <text x="108" y="170" font-size="11">MCP</text>
    <path d="M170 117 L300 117" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2" fill="none" stroke-dasharray="6 3"/>
    <text x="235" y="106" text-anchor="middle" font-size="12">A2A task</text>
    <path d="M450 108 L500 66" stroke="currentColor" fill="none"/>
    <path d="M450 128 L500 170" stroke="currentColor" fill="none"/>
    <text x="490" y="122" font-size="11">MCP</text>
    <rect x="290" y="20" width="360" height="210" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
  </g>
</svg>
<figcaption>A2A crosses the boundary between two agent systems. MCP connects each agent to its own tools. The client agent never sees the tools behind the remote agent.</figcaption>
</figure>

## Side by side

| Question | MCP | A2A |
| --- | --- | --- |
| What is on the other end? | A server offering tools, resources and prompts | An independent agent, opaque to the caller |
| How is it discovered? | The client asks the server with `tools/list` | An Agent Card, a JSON document, often at `/.well-known/agent-card.json` |
| What does the caller send? | A tool name and JSON arguments (`tools/call`) | A message made of one or more parts |
| What comes back? | A tool result: content items, optional structured content, `isError` | A task with a state, messages and artifacts |
| Long-running work | Progress notifications; tasks were added as experimental in 2025-11-25 and moved to an extension in 2026-07-28 | Built in: task states, streaming updates and push notifications to a webhook |
| Asking the caller for more | Elicitation (carried by the input-required retry pattern from 2026-07-28) | The task enters `TASK_STATE_INPUT_REQUIRED` |
| Wire format | JSON-RPC 2.0 over stdio or Streamable HTTP | JSON-RPC 2.0 over HTTP(S), gRPC, or HTTP+JSON/REST bindings |
| Authentication | Optional; an OAuth 2.1 based flow for HTTP servers, the environment for stdio | Schemes declared in the Agent Card: API key, HTTP auth, OAuth 2.0, OpenID Connect or mutual TLS |
| Who decides what happens? | The caller's model picks the tool and arguments | The remote agent decides how to do the task |

## What A2A defines

A2A 1.0 is built around a few objects:

- **Agent Card.** "A JSON metadata document published by an A2A Server, describing its identity, capabilities, skills, service endpoint" and how to authenticate. Each **skill** has an id, a name, a description, tags, examples and the input and output modes it accepts. The specification registers the well-known path `agent-card.json`, so a card is found at an address like `https://agent.example.com/.well-known/agent-card.json`.
- **Task.** "The fundamental unit of work managed by A2A, identified by a unique ID." A task moves through states such as submitted, working, input required, auth required, completed, failed, canceled and rejected.
- **Message and Part.** A message is "a communication turn between a client and a remote agent", made of parts, the smallest unit of content.
- **Artifact.** "An output (e.g., a document, image, structured data) generated by the agent as a result of a task."

The JSON-RPC binding names its operations `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask` and `SubscribeToTask`, plus methods for push notification settings. Streaming carries status changes and artifact chunks as they happen; push notifications are "server-initiated HTTP POST requests to a client-provided webhook URL", for work that outlives a connection.

MCP has none of these objects in its core. An MCP tool call is a request and a response, sized for a function. It can stream progress and, in newer revisions, ask for input, but it has no Agent Card, no artifacts and no task history.

## When to use which

**Use MCP when the other side is a capability.** Search a knowledge base, create a ticket, run a query, read a file. The input fits a schema, the output comes back in one result, and your agent should decide when to call it. Almost every integration an agent needs today is this shape.

**Use A2A when the other side is an agent you do not run.** Another team's or another company's agent, with its own model and tools, that you hand a goal to rather than a function call: "reconcile these invoices", "plan this trip". It may take minutes or hours, ask questions, and produce documents. You should not need to see its tools, and its owner may not want you to.

**Use neither inside one system you control.** If both agents run in the same application, delegating is just a function call. A <Term id="supervisor-agent">supervisor</Term> can treat each <Term id="worker-agent">worker</Term> as a tool, as described in [supervisor and worker agents](/learn/agents/supervisor-and-workers). A protocol adds discovery, authentication and a network hop that buy nothing when both sides share a process.

## How they combine

The A2A specification describes the two working together: an A2A client asks a remote agent to do a task, and that remote agent uses MCP to reach the tools and data it needs. In the diagram above, the boundary between the two systems is A2A and everything inside each system is MCP.

There is also a simpler bridge that only needs MCP: **wrap an agent as an MCP tool.** The remote team serves its agent as one tool, `plan_trip(destination, dates)`, from an MCP server. Your agent calls it like any other tool. This is easy, and works with any MCP client today. What you give up is what A2A adds on top: an Agent Card listing skills, a task you can poll, cancel or resubscribe to, structured artifacts, and a standard way for the remote agent to stop and ask for input. If those matter, the bridge is not enough.

## In L2M

L2M does not implement A2A. It does not publish Agent Cards or serve A2A endpoints, and it has no A2A client: it cannot discover A2A agents or follow their tasks. Agent-to-agent work in L2M goes through two mechanisms, both built on tools:

- **Inside one workflow: supervisor and workers.** A Supervisor node's `worker` port takes Agent Orchestrator or Supervisor nodes. Each worker reaches the supervisor's model as a synthetic tool, `delegate_to_<worker name>`, with one argument, `task_prompt`. Calling it runs the worker's own agent loop with its own chat model, tools and memory, and the worker's output comes back as the tool result. No protocol is involved: the runtime routes the call in process.
- **Across systems: workflows as MCP tools.** An **Expose as MCP Tool** trigger turns a workflow, agents inside included, into an MCP tool that the [MCP gateway](/product/mcp-gateway) serves to other MCP clients, such as an IDE agent or another L2M instance ([workflow as an MCP tool](/runtime/workflow-as-mcp-tool)). Each caller uses its own client token. This is the "wrap an agent as an MCP tool" bridge from the previous section, with its limits: one call is one run, and the caller gets the workflow's output as the tool result.

In the other direction, an L2M agent can reach a remote agent in two ways. If the agent is served as an MCP tool, attach it as an MCP Tool node. If it has an HTTP API, wrap the call in a small workflow with an HTTP Request node and attach that workflow with a [Workflow Tool](/runtime/workflow-tool) node; each call is then one request and one response, with none of A2A's task handling. Either way it is governed like any other tool: [tool policy](/product/mcp-tool-policy) can deny it or require approval, and calls are recorded in [tool-call telemetry](/product/mcp-tool-call-telemetry).

## Try it in L2M

Open the research team in the [live demo](https://lsquarem.com/demo/?mode=editor&workflowId=wf-demo-research-swarm){target="_self"}. Its recorded run shows a supervisor calling `delegate_to_researcher` and `delegate_to_analyst`, each worker calling its own MCP tool, and the supervisor combining the answers. It was recorded with a scripted stand-in model, so no key is needed.

## Further reading

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/) (a2a-protocol.org), including Appendix B, "Relationship to MCP"
- [MCP specification 2025-11-25: Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- Related guides: [Supervisor and worker agents](/learn/agents/supervisor-and-workers), [MCP vs function calling](/learn/mcp/mcp-vs-function-calling), [MCP hosts, clients and servers](/learn/mcp/hosts-clients-servers)
