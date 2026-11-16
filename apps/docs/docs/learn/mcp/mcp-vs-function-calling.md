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
<svg viewBox="0 0 660 230" role="img" aria-labelledby="fc-fig-title fc-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:660px">
  <title id="fc-fig-title">Where function calling and MCP sit</title>
  <desc id="fc-fig-desc">The model on the left talks to the agent application in the middle through function calling: tool definitions go to the model and tool calls come back. The agent application talks to MCP servers on the right through MCP: tools/list and tools/call go to the servers and tool lists and results come back.</desc>
  <defs><marker id="fc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="88" width="140" height="56" rx="8" fill="none" stroke="currentColor"/>
    <text x="90" y="112" text-anchor="middle">Model</text>
    <text x="90" y="130" text-anchor="middle" font-size="11">provider API</text>
    <rect x="260" y="88" width="140" height="56" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="330" y="112" text-anchor="middle">Agent app</text>
    <text x="330" y="130" text-anchor="middle" font-size="11">host + MCP clients</text>
    <rect x="500" y="40" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="65" text-anchor="middle">MCP server A</text>
    <rect x="500" y="152" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="177" text-anchor="middle">MCP server B</text>
    <path d="M258 104 L162 104" stroke="currentColor" fill="none" stroke-dasharray="4 3" marker-end="url(#fc-arrow)"/>
    <path d="M162 128 L258 128" stroke="currentColor" fill="none" stroke-dasharray="4 3" marker-end="url(#fc-arrow)"/>
    <text x="210" y="80" text-anchor="middle" font-size="12">function calling</text>
    <text x="210" y="96" text-anchor="middle" font-size="11">definitions in, calls out</text>
    <path d="M400 104 L498 64" stroke="currentColor" fill="none" marker-start="url(#fc-arrow)" marker-end="url(#fc-arrow)"/>
    <path d="M400 128 L498 168" stroke="currentColor" fill="none" marker-start="url(#fc-arrow)" marker-end="url(#fc-arrow)"/>
    <text x="450" y="28" text-anchor="middle" font-size="12">MCP</text>
    <text x="450" y="218" text-anchor="middle" font-size="11">tools/list, tools/call</text>
  </g>
</svg>
<figcaption>Function calling happens between the agent and the model. MCP happens between the agent and the tool servers. The model itself never talks to an MCP server.</figcaption>
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
| Can one tool definition serve several models? | No. Each provider has its own format, so code written for one needs converting for another | Yes. An MCP tool is model-neutral; the application converts it to whichever provider it calls, and any MCP client can use any MCP server |

## One request, traced end to end

Take an agent with a weather server attached, and the question "What is the weather in New York?". [What is MCP?](/learn/mcp/what-is-mcp#a-tool-call-step-by-step) shows the MCP messages of this call in full. This page follows the other half: what happens between the application and the model, and where the two layers meet.

**1. Discover (MCP).** The agent's MCP client sends `tools/list`. The server answers with `get_weather`: a `name`, a `description` and an `inputSchema` (a JSON Schema with one required `location` string).

**2. Translate (the application).** The model does not read MCP. The application rewrites each MCP tool into the format of the provider it is calling. The schema stays the same, but it moves to a different field:

```jsonc
// OpenAI function tool, Responses API shape
{ "type": "function", "name": "get_weather", "description": "Get current weather information for a location",
  "parameters": { "type": "object", "properties": { "location": { "type": "string" } }, "required": ["location"] } }

// Anthropic tool definition
{ "name": "get_weather", "description": "Get current weather information for a location",
  "input_schema": { "type": "object", "properties": { "location": { "type": "string" } }, "required": ["location"] } }
```

OpenAI's Chat Completions API nests the same fields under a `function` key: `{"type": "function", "function": {"name": ..., "parameters": ...}}`. This rewrite is the seam between the two layers. Everything left of it is the provider's format; everything right of it is MCP.

**3. Offer and choose (function calling).** The application sends the conversation and the translated tools to the model. OpenAI's guide lists the round trip in five steps: "Make a request to the model with tools it could call", "Receive a tool call from the model", "Execute code on the application side with input from the tool call", "Make a second request to the model with the tool output", and "Receive a final response from the model (or more tool calls)". Here the model answers with a call: `get_weather` with `{"location": "New York"}`. Anthropic's API returns the same thing as a `tool_use` block with `stop_reason: "tool_use"`, and each provider gives the call an id the result must refer back to.

**4. Execute (MCP).** The application maps the tool name back to the server it came from and sends `tools/call` with the model's arguments. The server runs the tool and returns `content` items with `isError: false`.

**5. Return (function calling).** The application converts the MCP result back into the provider's format and calls the model again: a `function_call_output` item with the call's `call_id` in OpenAI's guide, a `tool_result` block with the `tool_use_id` for Anthropic. The model writes its answer or asks for another tool.

Steps 3 to 5 repeat until the model stops asking. That repetition is the <Term id="agent-loop">agent loop</Term>. Only steps 1 and 4 are MCP, and step 2 exists only because the tool came from MCP. Steps 3 and 5 are the same whether a tool comes from an MCP server or from your own code.

## What MCP adds that function calling does not

Function calling covers only the model's side. MCP covers where a tool lives and how it runs:

- **Discovery at run time.** A server lists its tools, and a server that declares `listChanged` should send `notifications/tools/list_changed` when the list changes (from 2026-07-28, only to clients that subscribe). With plain function calling, the list is whatever your code puts in the request.
- **A process boundary.** The tool runs in the server, so a team ships it once and every MCP-capable app uses it.
- **One error contract on the server side.** Provider formats let you flag a tool result as an error too. What MCP adds is that every server reports tool failures the same way, as a result with `isError: true` that the application can pass to the model without knowing anything about the server.
- **More than functions.** A server can also offer resources (data the application reads) and prompts (templates a person picks). See [tools, resources and prompts](/learn/mcp/tools-resources-prompts).
- **Authorization for remote servers.** HTTP servers can require an OAuth access token through the [MCP authorization](/learn/mcp/authorization) flow. Function calling has no notion of credentials at all.

And what function calling has that MCP does not: the model. MCP never calls a model to pick a tool. The choice of which tool to call, with which arguments, is always made through the provider's function calling.

## When to use which

You always need function calling if a model is choosing tools. The real question is whether the tools come from MCP servers or from your own code.

**Plain function calling, tools in your code, is enough when:**

- the tools are a few functions in the same codebase as the agent;
- one application uses them, and no other agent or editor needs them;
- they need no credentials of their own.

**Put the tools behind MCP when:**

- several apps or agents should share the same tools, including IDE agents and desktop assistants;
- another team, or an outside vendor, owns the tool and ships updates;
- the tool needs its own credentials, which should stay out of your application and out of the model's context;
- you want a boundary to govern: an allow-list of tools, approval for writes, a record of each call.

Some model providers can also act as the MCP client themselves: OpenAI lists MCP among its built-in tools, and Anthropic's MCP connector lets the Messages API reach remote MCP servers "without a separate MCP client". The provider then makes the `tools/call` requests from its own infrastructure. Those calls bypass your application, so your own approvals and logs do not see them.

## Mistakes the comparison prevents

- **"MCP replaces function calling."** It does not. An MCP tool still reaches the model as a function definition, so MCP cannot fix a model that is bad at tool calling.
- **"The model calls the MCP server."** It never does. It only names a tool. Your application, or with provider-hosted MCP the provider's infrastructure, makes the call.
- **"More servers is better."** Every tool from every server becomes a function definition in each request, which costs tokens and makes wrong picks more likely.

## In L2M

An Agent Orchestrator node is the application in the trace above. Its MCP Tool nodes (on the `tool` port) are the MCP side, and its chat model node (on the `chat_model` port) is the function calling side.

- **Discovery and calls** go through L2M's MCP adapters: `http_mcp` for Streamable HTTP servers, `stdio_mcp` for local processes. Servers are best registered once in the [MCP server registry](/product/mcp-server-registry).
- **Translation** happens in the provider adapters: the nested Chat Completions `function` form for OpenAI-compatible providers, `input_schema` for Anthropic. Switching the chat model does not touch the tools.
- **Names.** A server's tool reaches the model as `<adapter>__<tool>`, for example `http_mcp__get_weather`, so the runtime can map the call back to its server. Clashing names get a short hash. See [Tool names the model sees](/runtime/agent-loop#tool-names-the-model-sees).
- **Trimming.** When an agent run starts, the runtime trims tool definitions once: descriptions are cut at 280 characters, only the first 8 top-level argument properties are kept, and nested properties below them are dropped. See [Too many tools](/learn/agents/too-many-tools).
- **Not only MCP.** A [Workflow Tool](/runtime/workflow-tool) node and a supervisor's workers also reach the model as functions. The model cannot tell them from MCP tools; the runtime routes each call.

Optional [tool policy](/product/mcp-tool-policy) can sit between the model's choice and the MCP call.

## Try it in L2M

Open the support agent in the [live demo](https://lsquarem.com/demo/?mode=editor&workflowId=wf-demo-support-agent){target="_self"} to see the function calling side of a recorded run: each tool call the model asked for, with its name and arguments, and the result sent back to the model before its next call.

## Further reading

- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling) (OpenAI)
- [Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) (Anthropic)
- Related guides: [What is MCP?](/learn/mcp/what-is-mcp), [MCP vs REST APIs](/learn/mcp/mcp-vs-rest-api), [What is an AI agent?](/learn/agents/what-is-an-ai-agent)
