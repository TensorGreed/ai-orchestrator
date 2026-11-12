---
title: "LLM gateway vs MCP gateway: what each one governs"
sidebarTitle: "LLM gateway vs MCP gateway"
description: "An LLM gateway sits between apps and models; an MCP gateway sits between agents and tools. What each controls, where they overlap, and when you need both."
level: intermediate
about: llm-gateway
related: [llm-gateway, mcp-gateway, openai-compatible-api, model-allowlist, budget]
socialCard: true
---

# LLM gateway vs MCP gateway

An <Term id="llm-gateway">LLM gateway</Term> (often called an AI gateway) sits between your applications and the model providers: it decides which model a caller may use, with which key, how often and at what cost. An <Term id="mcp-gateway">MCP gateway</Term> sits between AI agents and the tools they call over the <Term id="model-context-protocol">Model Context Protocol</Term>: it decides which tools a client may see and call, with which arguments, and records each call. One governs what the model is asked; the other governs what the agent does. If MCP is new to you, start with [what MCP is](/learn/mcp/what-is-mcp).

## Two kinds of traffic

An AI agent sends two kinds of requests, and they go to different places.

1. **Model calls.** The agent sends the conversation and its tool definitions to a model provider and gets back text, or a request to call a tool. This is a chat completion: HTTP to a provider such as OpenAI, Anthropic, Gemini or a local Ollama server.
2. **Tool calls.** When the model asks for a tool, the agent runs it. With MCP, that is a `tools/call` request to an MCP server, which then reads a database, opens a ticket or pushes a commit.

<figure>
<svg viewBox="0 0 640 230" role="img" aria-labelledby="gw-fig-title gw-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="gw-fig-title">Where each gateway sits</title>
  <desc id="gw-fig-desc">An agent or app in the middle. Model calls go up through an LLM gateway to model providers. Tool calls go down through an MCP gateway to MCP servers.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="240" y="95" width="160" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="320" y="120" text-anchor="middle">Agent or app</text>
    <rect x="20" y="20" width="170" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="105" y="45" text-anchor="middle">LLM gateway</text>
    <rect x="450" y="20" width="170" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="535" y="45" text-anchor="middle">Model providers</text>
    <rect x="20" y="170" width="170" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="105" y="195" text-anchor="middle">MCP gateway</text>
    <rect x="450" y="170" width="170" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="535" y="195" text-anchor="middle">MCP servers (tools)</text>
    <path d="M260 95 L170 62" stroke="currentColor" fill="none"/>
    <path d="M190 40 L450 40" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
    <text x="320" y="33" text-anchor="middle" font-size="12">model calls: prompt, model name, tokens</text>
    <path d="M260 135 L170 168" stroke="currentColor" fill="none"/>
    <path d="M190 190 L450 190" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
    <text x="320" y="183" text-anchor="middle" font-size="12">tool calls: tool name, arguments, result</text>
  </g>
</svg>
<figcaption>The two gateways sit on different paths. The LLM gateway sees what the model is told about a tool call; only the MCP gateway sees the call itself.</figcaption>
</figure>

The model never runs a tool. It only names one. So a gateway on the model path sees the model *asking* for a tool, and later the result the application chooses to send back. A gateway on the tool path sees the call that actually happens. That difference decides what each one can control.

## What an LLM gateway controls

An LLM gateway is one endpoint that applications use instead of calling each provider directly. Most speak an <Term id="openai-compatible-api">OpenAI-compatible API</Term>, so any OpenAI SDK works by changing its base URL. Typical controls:

- **Routes.** Callers ask for a public model name, such as `fast-chat`. The gateway maps it to a provider, an upstream model and a stored key. Swapping the provider behind a name does not touch any application.
- **Keys per caller.** Each application gets its own gateway token. Provider keys stay on the gateway, so one leaked app token can be revoked without rotating the provider key for everyone.
- **Budgets and rate limits.** Spend or token caps per caller, team or project, and calls per minute. Without them, one runaway loop can spend a month's allowance; OWASP lists this as LLM10, Unbounded Consumption.
- **<Term id="model-allowlist">Model allowlists</Term>.** Which models may be called at all, for example only models your contracts or data rules allow.
- **Checks on text.** Optional checks on the prompt before it leaves and on the answer before it returns.
- **Usage records.** Tokens, cost, latency and outcome per request, for chargeback and incident review.

What it cannot do is stop a tool from running. If the model answers with a `tool_calls` entry, the gateway passes it back and the application runs the tool itself. The gateway can block the whole answer. It sees a tool's result only if the application sends it back to the model on the next request, and it never sees what the call changed in the other system.

## What an MCP gateway controls

An MCP gateway is an MCP server that sits in front of other MCP servers. Clients such as IDE agents, desktop assistants and command-line agents connect to it over Streamable HTTP, and it forwards their calls to the real servers. Typical controls:

- **Toolsets.** A named group of tools served at one endpoint. A support team's agents get the ticket tools; a release bot gets the deploy tools. A client only sees the toolsets it was given.
- **A token per client.** Each client authenticates with its own token. The gateway holds the upstream servers' credentials and adds them itself, so clients never receive a code host or database secret. The MCP security guidance forbids the shortcut where a server accepts a token that was not issued to it and forwards it downstream ("token passthrough"): "MCP servers MUST NOT accept any tokens that were not explicitly issued for the MCP server."
- **Rules per tool call.** Allow, deny or require a human approval for a tool, and, in stricter gateways, for particular argument values (deny `push` to a production repository, hold refunds above an amount for approval).
- **Budgets and rate limits** on tool calls. The MCP specification says servers MUST "Rate limit tool invocations"; a gateway is one place to do it for every server behind it.
- **Telemetry and audit.** Which client called which tool, when, with what outcome.

What it cannot do is limit the agent's own model spend or choose its model. It never sees the prompt that led to the call.

## Where the names get muddled

"AI gateway" is used for both, and some products bundle both behind one admin screen. These questions sort a product into one column or the other:

| Question | LLM gateway | MCP gateway |
| --- | --- | --- |
| What protocol do callers speak? | A model API, usually OpenAI-compatible chat completions | MCP (JSON-RPC over Streamable HTTP) |
| What does one request ask for? | A completion from a named model | A call to a named tool with arguments |
| What does a rule decide? | Which model, how much spend, what text may pass | Which tool, which arguments, who must approve |
| Whose credentials does it hold? | Model provider keys | Credentials for databases, SaaS APIs, code hosts |
| What does a refusal look like? | An HTTP error such as `429` | A JSON-RPC error or a tool error the agent reads |

When a model-side gateway talks about governing tools, check which side it means. Filtering `tool_calls` in model answers is useful, but it is not the same as deciding each tool call with its real arguments at the point where it runs.

## Do you need both?

It depends on what leaves your network and who calls what.

- **Apps call models, no agents with tools:** an LLM gateway is enough.
- **Agents in IDEs or desktop apps call shared tools, and each person brings their own model subscription:** an MCP gateway is the part you control. Model calls go from the client to its provider, outside your gateway.
- **Your own agents call models and tools:** you need both. The LLM gateway caps spend and picks models; the MCP gateway decides what the agents may do with the answers.

If you run both, give each caller one identity across them. A cap per client then means the same thing on both paths, and an incident review can follow one client from the prompt to the tool call.

## Both in one self-hosted deployment

[L2M](/why) has both, and both are optional: nothing is served until you configure it.

- **The [/v1 AI gateway](/product/ai-gateway)** serves an OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`). Admins define route sets that map public model names to providers and stored keys. Each request is checked against the client's grant, its rate limit, [budgets](/product/budgets) and the [model allowlists](/security/model-allowlists) before the provider is called, and writes a usage row with tokens and estimated cost, never the prompt or answer. A used-up block budget answers `429` with code `insufficient_quota`.
- **The [MCP gateway](/product/mcp-gateway)** serves toolsets at `/mcp/<toolset>` over Streamable HTTP, speaking MCP protocol versions 2025-11-25, 2025-06-18 and 2025-03-26. A toolset can hold workflows exposed as tools and tools of registered MCP servers. Calls to server tools go through [MCP tool policy](/product/mcp-tool-policy) and get the server's secret from the gateway; a workflow tool runs its workflow, whose agents check policy in turn. Calls that reach a tool write a telemetry row. Budgets and per-client rate limits are optional: a used-up block budget refuses the call with JSON-RPC error `-32032`, and a rate limit with `-32029`.

The two share one set of client tokens, created under **MCP → Clients**. A client's rate limit is one allowance across both paths, and a budget with the MCP client scope counts its `/v1` usage and its gateway usage together. The reverse direction also works: an agent inside an L2M workflow can send its model calls to an existing corporate gateway through the **AI Gateway Chat Model** node.

```bash
# Model traffic: any OpenAI SDK, pointed at L2M
curl https://l2m.example.com/v1/chat/completions \
  -H "Authorization: Bearer $L2M_CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "fast-chat", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Try it in L2M

Follow [Run a self-hosted MCP gateway](/guides/self-hosted-mcp-gateway) to put one toolset in front of a registered server and connect an IDE agent with its own token. Then add a route set with one route and its provider key under **MCP → AI routes**, and tick it under **AI routes** in the same client's **Governance** section (**MCP → Clients**) to send its model calls through `/v1`. To watch an agent call MCP tools without installing anything, open the support agent in the [live demo](https://lsquarem.com/demo/?mode=editor&workflowId=wf-demo-support-agent){target="_self"}.

## Further reading

- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) (modelcontextprotocol.io): token passthrough, confused deputy, scope minimisation
- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): security considerations for servers and clients
- [MCP specification 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io)
- [OWASP LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/) (genai.owasp.org)
- L2M docs: [/v1 AI gateway](/product/ai-gateway), [MCP gateway](/product/mcp-gateway), [Model allowlists](/security/model-allowlists)
