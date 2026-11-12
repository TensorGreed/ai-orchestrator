---
title: "LLM gateway (AI gateway): what it does"
term: "LLM gateway"
topic: operations
definition: "A service between applications and model providers that gives them one API endpoint and adds per-client keys, routing, spend limits, rate limits and checks on prompts and answers."
description: "An LLM gateway sits between apps and model providers: one endpoint, per-client keys, routing, budgets, rate limits and checks on prompts and answers."
related: [mcp-gateway, openai-compatible-api, budget, rate-limit, model-allowlist, unbounded-consumption]
guide: [/learn/operations/llm-gateway-vs-mcp-gateway, /learn/operations/llm-cost-control]
---

# LLM gateway

**A service between applications and model providers that gives them one API endpoint and adds per-client keys, routing, spend limits, rate limits and checks on prompts and answers.**

Also called an AI gateway. Without one, every application holds its own provider keys, picks its own models and reports its own spend, if it reports it at all. A gateway moves those decisions to one place. Applications call the gateway, usually through an <Term id="openai-compatible-api">OpenAI-compatible API</Term>, so existing SDKs work by changing the base URL and the key.

## What it usually does

- **Keys.** Each application gets its own gateway token. Provider keys stay in the gateway and can be rotated without touching applications.
- **Routing.** A public model name such as `fast-chat` maps to a provider and model, so the backend can change without a code change.
- **Limits.** Per-client <Term id="budget">budgets</Term> and <Term id="rate-limit">rate limits</Term>, the controls OWASP lists against <Term id="unbounded-consumption">unbounded consumption</Term> (LLM10).
- **Checks and records.** Allowed models, checks on prompts and answers, and a usage record per call.

## Example

Three internal apps call `fast-chat`. Finance gets a $200 monthly budget, the chatbot a rate limit of 60 calls a minute. When the provider raises prices, the gateway route moves `fast-chat` to another model; no app is redeployed.

## Common confusion

An LLM gateway governs model calls: prompts in, completions out. An <Term id="mcp-gateway">MCP gateway</Term> governs tool calls. An agent uses both: the model call goes through one, each tool call through the other.

## In L2M

The optional [AI gateway](/product/ai-gateway) serves an OpenAI-compatible API at `/v1`: routes map public model names to providers, clients use L2M client tokens, and budgets, rate limits, [model allowlists](/security/model-allowlists) and content rules apply. With no route set up, it stays off.

## Further reading

- [OWASP LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/) (owasp.org)
