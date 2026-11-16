---
title: "MCP vs function calling: how they fit together"
sidebarTitle: "MCP vs function calling"
description: "Function calling is how a model asks for a tool; MCP is how an app finds and runs tools from servers. Where each sits, with one request traced end to end."
level: beginner
about: tool-calling
demo: wf-demo-support-agent
demoRecorded: true
related: [tool-calling, model-context-protocol, mcp-tool, mcp-client, agent-loop]
---

# MCP vs function calling

<Term id="tool-calling">Function calling</Term> (also called tool calling) is a feature of a model's API: you send tool definitions with the request, and the model can answer with a structured request to run one of them, a name plus JSON arguments, instead of text. Your application runs the tool and sends the result back. The <Term id="model-context-protocol">Model Context Protocol</Term> (MCP) is a protocol between your application and separate tool servers: it lets the application ask a server which tools it has (`tools/list`) and run one (`tools/call`). They are not alternatives. Function calling is the conversation between the application and the model; MCP is the conversation between the application and the tools. A typical agent uses both in every turn.

## Two conversations, one agent

The confusion comes from the fact that both describe tools with a name, a description and a JSON Schema. But they are spoken by different parties.

<figure>
<svg viewBox="0 0 660 220" role="img" aria-labelledby="fc-fig-title fc-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:660px">
  <title id="fc-fig-title">Where function calling and MCP sit</title>
  <desc id="fc-fig-desc">The model on the left talks to the agent application in the middle through function calling: tool definitions go to the model and tool calls come back. The agent application talks to MCP servers on the right through MCP: tools/list and tools/call go to the servers and tool lists and results come back.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="80" width="140" height="56" rx="8" fill="none" stroke="currentColor"/>
    <text x="90" y="104" text-anchor="middle">Model</text>
    <text x="90" y="122" text-anchor="middle" font-size="11">provider API</text>
    <rect x="260" y="80" width="140" height="56" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="330" y="104" text-anchor="middle">Agent app</text>
    <text x="330" y="122" text-anchor="middle" font-size="11">host + MCP clients</text>
    <rect x="500" y="40" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="65" text-anchor="middle">MCP server A</text>
    <rect x="500" y="136" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="161" text-anchor="middle">MCP server B</text>
    <path d="M160 98 L260 98" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
    <path d="M160 118 L260 118" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
    <text x="210" y="60" text-anchor="middle" font-size="12">function calling</text>
    <text x="210" y="76" text-anchor="middle" font-size="11">definitions in, calls out</text>
    <path d="M400 100 L500 62" stroke="currentColor" fill="none"/>
    <path d="M400 116 L500 154" stroke="currentColor" fill="none"/>
    <text x="450" y="30" text-anchor="middle" font-size="12">MCP</text>
    <text x="450" y="205" text-anchor="middle" font-size="11">tools/list, tools/call</text>
  </g>
</svg>
<figcaption>Function calling happens between the agent and the model. MCP happens between the agent and the tool servers. The model never talks to an MCP server.</figcaption>
</figure>

| Question | Function calling | MCP |
| --- | --- | --- |
| Who talks to whom? | Your application and a model API | Your application (an <Term id="mcp-client">MCP client</Term>) and an <Term id="mcp-server">MCP server</Term> |
| Who defines it? | Each model provider, in its own API format | One open specification at modelcontextprotocol.io |
| What does it standardise? | How tools are offered to a model and how the model asks for one | How tools are listed, called, described and changed, and how errors come back |
| Where does the tool's code run? | Wherever your application runs it | In the MCP server, a local process or a remote service |
| How are tools found? | You put the list in each request yourself | The client asks the server with `tools/list`, and can hear when the list changes |
| What is the wire format? | The provider's HTTP API | JSON-RPC 2.0 over stdio or Streamable HTTP |
| Who decides a call runs? | Your application, after the model asks | Your application, then the server enforces its own access controls |
| Portable across models? | No. Field names differ by provider | Yes. Any MCP client can use any MCP server |

## One request, traced end to end

Take an agent with a weather server attached, and the question "What is the weather in New York?". Here is every step, with the side that owns it.

**1. Discover (MCP).** The agent's MCP client sends `tools/list`. The server answers with its tools, each with a `name`, a `description` and an `inputSchema`:

```json
{ "name": "get_weather", "description": "Get current weather information for a location",
  "inputSchema": { "type": "object", "properties": { "location": { "type": "string" } }, "required": ["location"] } }
```

**2. Translate (the application).** The model does not read MCP. The application rewrites each MCP tool into the format of the provider it is calling. The schema stays the same, but it moves to a different field: OpenAI's function tools put it in `parameters` (with `"type": "function"`), and Anthropic's tool definitions put it in `input_schema`. This rewrite is the seam between the two layers.

**3. Offer and choose (function calling).** The application sends the conversation and the translated tools to the model. OpenAI's guide lists the steps of the round trip as: "Make a request to the model with tools it could call", "Receive a tool call from the model", "Execute code on the application side with input from the tool call", "Make a second request to the model with the tool output". The model answers with a call: `get_weather` with `{"location": "New York"}`. Anthropic's API returns this as a `tool_use` block with `stop_reason: "tool_use"`.

**4. Execute (MCP).** The application maps the name back to the server it came from and sends a JSON-RPC request:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "get_weather", "arguments": { "location": "New York" } } }
```

The server runs the tool and returns a `result` with `content` items and `isError: false`.

**5. Return (function calling).** The application puts the result into the conversation in the provider's format (a `function_call_output` item in OpenAI's guide, a `tool_result` block for Anthropic) and calls the model again. The model writes its answer or asks for another tool.

Steps 3 to 5 repeat until the model stops asking. That repetition is the <Term id="agent-loop">agent loop</Term>. Only steps 1 and 4 are MCP.

## What MCP adds that function calling does not

Function calling only covers the model's side. Everything about where a tool lives and how it is run is up to you. MCP fills in that part:

- **Discovery at run time.** A server lists its tools, and a server that declares `listChanged` should send `notifications/tools/list_changed` when the list changes. With plain function calling, the list is whatever your code puts in the request.
- **A process boundary.** The tool runs in the server, not in your application. A team can ship a ticketing server once, and every MCP-capable app uses it without copying code.
- **Errors the model can use.** The tools specification separates protocol errors (an unknown tool, a malformed request) from tool execution errors, which come back as a normal result with `isError: true` and "contain actionable feedback that language models can use to self-correct and retry".
- **More than functions.** A server can also offer resources (data the application reads) and prompts (templates a person picks). See [tools, resources and prompts](/learn/mcp/tools-resources-prompts).
- **Authorization for remote servers.** HTTP servers can require an OAuth access token through the [MCP authorization](/learn/mcp/authorization) flow. Function calling has no notion of credentials at all.

And what function calling has that MCP does not: the model. MCP never calls a model to pick a tool (sampling, where a server asks the client for a completion, is a separate feature that the 2026-07-28 revision deprecates). The choice of which tool to call, with which arguments, is always made through the provider's function calling.

## When to use which

You always need function calling if a model is choosing tools. The real question is whether the tools come from MCP servers or from your own code.

**Plain function calling, tools in your code, is enough when:**

- the tools are a few functions in the same codebase as the agent;
- one application uses them, and no other agent or editor needs them;
- they need no credentials beyond what the application already has.

**Put the tools behind MCP when:**

- several apps or agents should share the same tools, including IDE agents and desktop assistants;
- another team, or an outside vendor, owns the tool and ships updates;
- the tool needs its own credentials, which should stay out of your application and out of the model's context;
- you want a boundary to govern: an allow-list of tools, approval for writes, a record of each call.

Some model providers can also act as the MCP client themselves: OpenAI lists MCP among its built-in tools, and Anthropic's MCP connector lets the Messages API reach remote MCP servers "without a separate MCP client". The provider then makes the `tools/call` requests from its own infrastructure. That is convenient, but the calls no longer pass through your application, so your own approvals and logs do not see them, and the server must be reachable from the provider.

## Mistakes the comparison prevents

- **"MCP replaces function calling."** It does not. An MCP tool still reaches the model as a function definition. If a model is bad at tool calling, MCP will not fix that.
- **"The model calls the MCP server."** It never does. It only names a tool. The application decides whether to run it, which is where approvals and policies belong.
- **"More servers is better."** Every tool from every server becomes a function definition in each request, which costs tokens and makes wrong picks more likely. See [Too many tools](/learn/agents/too-many-tools).
- **"Tool descriptions are just docs."** A description goes straight into the model's context. A careless or hostile server can put instructions there, so pick servers you trust. See [MCP security risks](/learn/security/mcp-security-risks).

## In L2M

An Agent Orchestrator node is the application in the trace above. Its MCP Tool nodes (on the `tool` port) are the MCP side, and its chat model node (on the `chat_model` port) is the function calling side.

- **Discovery and calls** go through L2M's MCP adapters: `http_mcp` for Streamable HTTP servers, `stdio_mcp` for local processes. Servers are best registered once in the [MCP server registry](/product/mcp-server-registry).
- **Translation** happens in the provider adapters. The same MCP tool becomes a `"type": "function"` entry for OpenAI-compatible providers and an `input_schema` entry for Anthropic. Switching the chat model does not touch the tools.
- **Names.** A server's tool reaches the model as `<adapter>__<tool>`, for example `http_mcp__get_weather`, so the runtime can map the call back to its server. Clashing names get a short hash. See [Tool names the model sees](/runtime/agent-loop#tool-names-the-model-sees).
- **Trimming.** Before each model call, the runtime trims tool definitions: descriptions are cut at 280 characters and only the first 8 top-level argument properties are kept.
- **Not only MCP.** A [Workflow Tool](/runtime/workflow-tool) node and a supervisor's workers also reach the model as functions. The model cannot tell them from MCP tools; the runtime routes each call.

Optional controls sit between the model's choice and the MCP call: [tool policy](/product/mcp-tool-policy) to allow, deny or require approval per tool, and [approvals](/product/approvals) before write tools. A simple agent needs none of them.

## Try it in L2M

Open the support agent in the [live demo](https://lsquarem.com/demo/?mode=editor&workflowId=wf-demo-support-agent){target="_self"}. Its recorded run shows both layers: the model's tool calls and the MCP `tools/call` results, including a calculator call that fails with `isError: true` and a corrected retry. The recording used a scripted stand-in model, so no key is needed.

To build an agent yourself, follow the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent). It uses the built-in echo model, which never asks for a tool, so the MCP side is wired but no call happens until you attach a real chat model.

## Further reading

- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling) (OpenAI)
- [Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) (Anthropic)
- Related guides: [What is MCP?](/learn/mcp/what-is-mcp), [MCP vs REST APIs](/learn/mcp/mcp-vs-rest-api), [What is an AI agent?](/learn/agents/what-is-an-ai-agent)
