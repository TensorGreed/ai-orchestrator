---
title: "OpenTelemetry GenAI semantic conventions"
term: "GenAI semantic conventions"
topic: operations
definition: "OpenTelemetry's shared names for the spans, attributes and metrics of model calls, agents and tool calls, such as `chat`, `invoke_agent` and `gen_ai.usage.input_tokens`."
description: "The OpenTelemetry GenAI semantic conventions name model, agent and tool spans (gen_ai.*) so any backend can read them. Status, content capture, examples."
related: [opentelemetry, trace-context-propagation, tool-call-telemetry, agent-loop, tool-calling]
---

# GenAI semantic conventions

**OpenTelemetry's shared names for the spans, attributes and metrics of model calls, agents and tool calls, such as `chat`, `invoke_agent` and `gen_ai.usage.input_tokens`.**

<Term id="opentelemetry">OpenTelemetry</Term> carries traces from any app to any backend, but a backend can only build a token-usage chart or an agent timeline if every app names things the same way. Semantic conventions are those names. The GenAI set covers:

- **Model spans.** One CLIENT span per call to a model, named `{gen_ai.operation.name} {gen_ai.request.model}`, such as `chat gpt-4o`. `gen_ai.operation.name` and `gen_ai.provider.name` are required; others record the request (`gen_ai.request.temperature`), the response (`gen_ai.response.finish_reasons`) and usage (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`).
- **Agent, tool and other spans.** Well-known operation names include `invoke_agent`, `execute_tool`, `invoke_workflow`, `embeddings` and `retrieval`.
- **Metrics** such as `gen_ai.client.operation.duration` and `gen_ai.client.token.usage`, and **events** that carry inputs and outputs.
- **Provider-specific** additions, and a related set of conventions for MCP.

## Status

The conventions are marked **Development**, not stable: names can still change between releases. The text has since moved out of the main semantic-conventions repository into a separate GenAI repository, which has no release yet; the v1.41 releases are the last semantic-conventions releases that carry it. Because of the churn, release v1.41.0 asks instrumentations that already emit v1.36.0 or earlier to keep that version by default, and to switch only when `OTEL_SEMCONV_STABILITY_OPT_IN` includes `gen_ai_latest_experimental`. Check which version a tool pins before you build dashboards on its names.

## Example

```
invoke_agent support-triage              gen_ai.usage.input_tokens = 5120
├─ chat gpt-4o              CLIENT       gen_ai.provider.name = openai
│                                        gen_ai.response.finish_reasons = ["tool_calls"]
├─ execute_tool search_tickets           gen_ai.tool.name = search_tickets
└─ chat gpt-4o              CLIENT       gen_ai.response.finish_reasons = ["stop"]
```

## Common confusion

- **Conventions are names, not a library.** Any code can emit them; an auto-instrumentation package is one way.
- **Content is opt-in.** `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions` are marked Opt-In. The spec warns that the input and output messages are likely to contain sensitive information, including personal data, and that system instructions may contain sensitive information. By default a span holds ids, models, timings and token counts, not prompts.

## In L2M

When [OpenTelemetry export](/operations/opentelemetry) is turned on (off by default), L2M emits these names itself, pinned at v1.41.0: `invoke_workflow`, `invoke_agent` and `execute_tool` [run spans](/operations/opentelemetry#run-spans), `chat` and `embeddings` [model spans](/operations/opentelemetry#model-spans) with `gen_ai.*` attributes, MCP spans, and the [GenAI metrics](/operations/opentelemetry#genai-and-cost-metrics). `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` switches the metrics to the newer names. [Content capture](/operations/opentelemetry#content-capture) is off by default (`NO_CONTENT`) and, when turned on, records masked content.

## Further reading

- [GenAI semantic conventions, v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/README.md) (OpenTelemetry, GitHub)
- [GenAI model spans, v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-spans.md) (OpenTelemetry, GitHub)
- [OpenTelemetry GenAI semantic conventions repository](https://github.com/open-telemetry/semantic-conventions-genai) (OpenTelemetry, GitHub)
- [Generative AI semantic conventions (moved notice)](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (opentelemetry.io)
