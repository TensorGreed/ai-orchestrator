---
title: "Prompt caching: reuse the start of a prompt"
term: "Prompt caching"
topic: operations
definition: "A model provider's reuse of the already-processed start of a prompt when a later request begins with exactly the same text, which cuts the cost and latency of that part."
description: "Prompt caching lets a provider reuse the processed start of a prompt across calls, cutting cost and latency. How it differs from caching answers."
related: [context-window, token-llm, budget, genai-semantic-conventions, llm-gateway]
guide: [/learn/operations/llm-cost-control]
---

# Prompt caching

**A model provider's reuse of the already-processed start of a prompt when a later request begins with exactly the same text, which cuts the cost and latency of that part.**

An agent sends much the same prompt on every call: system prompt, tool definitions, then a conversation that grows at the end. With caching, the provider keeps the processed prefix for a short while, and a request that starts with the same tokens reuses it. Reading from the cache is billed below the normal input rate: Anthropic, for one, charges a tenth of the base input price or less.

The match is on a prefix, so order matters. Put what stays the same (instructions, tools, reference text) first and what changes last. This is why the MCP 2026-07-28 revision asks servers to list tools in a deterministic order: a stable tool list keeps the prefix stable (see [too many tools](/learn/agents/too-many-tools)).

Providers handle it differently:

- **OpenAI** caches automatically on supported models, above a minimum prompt length, and reports the cached part in the usage of each response. Its documentation says caching does not change how the model generates output.
- **Anthropic**'s Messages API caches only when the request asks for it with `cache_control`, either at the top level or on chosen blocks. The default lifetime is 5 minutes. Writing to the cache costs more than normal input; reading costs much less.
- **Gemini** applies implicit caching by default to Gemini 2.5 and newer models.

## Example

A support agent has a 3,000-token system prompt and tool list. A second call a minute later starts with the same 3,000 tokens plus the new turn, so the provider reports most of the input as cached and bills it at the cached rate.

## Common confusion

Prompt caching does not store answers. The model still generates a fresh reply each time; only the work of reading the shared start is saved. Caching answers (returning a stored reply when the same question comes again) is a different technique, done by the application or a gateway, and it does return the old answer.

## In L2M

L2M sends no cache settings: no `cache_control` for Anthropic and no cache options for other providers. Caching therefore happens only where the provider does it by itself. The adapters read the cached-token count providers report: `prompt_tokens_details.cached_tokens` from OpenAI, Azure OpenAI and OpenAI-compatible APIs, `cachedContentTokenCount` from Gemini, and `cache_read_input_tokens` from Anthropic (zero for L2M's requests, since L2M never asks Anthropic to cache). Anthropic counts cache reads and writes apart from `input_tokens`, so L2M adds them back: input tokens are always the whole prompt, and cached tokens the part of it read from the cache. [Cost estimates](/product/budgets) price the cached tokens at the model's cached-input rate (`cachedInputUsdPer1M` in the price table or `LLM_PRICING_OVERRIDES_JSON`), or at the normal input rate when there is none, and the rest of the prompt at the input rate, and [model spans](/operations/opentelemetry#model-spans) carry them as `gen_ai.usage.cache_read.input_tokens`.

## Further reading

- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) (OpenAI)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (Anthropic)
- [Context caching](https://aistudio.google.com/docs/caching) (Google AI Studio)
