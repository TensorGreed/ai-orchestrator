---
title: "Map agent traces to OpenTelemetry GenAI conventions"
sidebarTitle: "OpenTelemetry GenAI conventions"
description: "The gen_ai span and metric names for model calls, agents and tools, why they are still in development, and how to map your traces to them."
level: advanced
about: genai-semantic-conventions
related: [genai-semantic-conventions, opentelemetry, trace-context-propagation, tool-call-telemetry, agent-loop, tool-calling]
---

# Map agent traces to OpenTelemetry GenAI conventions

The <Term id="genai-semantic-conventions">OpenTelemetry GenAI semantic conventions</Term> are shared names for the spans, attributes and metrics of model calls, agents and tool calls. A model call is a CLIENT span named `{gen_ai.operation.name} {gen_ai.request.model}`, such as `chat gpt-4o`. A tool call is an `execute_tool {gen_ai.tool.name}` span, and an agent run is `invoke_agent {gen_ai.agent.name}`. Token counts go in `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, and the provider in `gen_ai.provider.name`, which replaced `gen_ai.system` in release 1.37.0. Every one of these names is still at **Development** status, the earliest maturity level, so they can change between releases. To map your own traces, pin one version, emit its names and required attributes, keep everything else under your own prefix, and plan for one rename when the conventions move again.

## Where the conventions live now

Until release v1.41.0, the GenAI and MCP conventions were part of the main `open-telemetry/semantic-conventions` repository. They have since moved to their own repository, `open-telemetry/semantic-conventions-genai`, and the GenAI pages on opentelemetry.io now say: "This page has moved and is no longer maintained in this repository." When we checked on 16 November 2026, the new repository had no release yet. So the last released text is v1.41.0, and the newer text exists only on that repository's main branch.

The documents are split by signal:

- **Model spans**: inference (chat, text completion), embeddings, retrieval and tool execution.
- **Agent spans**: `create_agent`, `invoke_agent` and `invoke_workflow`.
- **Metrics**: client metrics such as token usage and operation duration, and server metrics such as time to first token.
- **Events**: the opt-in content of a model call.
- **MCP**: spans and metrics for Model Context Protocol requests.
- **Provider pages**: extra attributes for some providers, such as OpenAI, Anthropic, Azure AI Inference and AWS Bedrock.

Each page is marked "Status: Development". OpenTelemetry's maturity levels describe Development as the stage where "Not all pieces of the component are in place yet", with none of the promises a Stable document makes about keeping names. The GenAI pages add a transition plan for instrumentation built on v1.36.0 or earlier. Such instrumentation "SHOULD NOT change the version of the GenAI conventions that they emit by default", and "SHOULD introduce an environment variable `OTEL_SEMCONV_STABILITY_OPT_IN`". One of its values, `gen_ai_latest_experimental`, means: "emit the latest experimental version of GenAI conventions (supported by the instrumentation) and do not emit the old one".

In practice: the default names stay put until you ask for new ones, and you can ask with one setting.

## The span names

| What happened | `gen_ai.operation.name` | Span name | Kind |
| --- | --- | --- | --- |
| A chat or completion call to a model | `chat`, `text_completion`, `generate_content` | `{operation} {gen_ai.request.model}` | CLIENT (INTERNAL for a model in the same process) |
| An embeddings call | `embeddings` | `embeddings {gen_ai.request.model}` | CLIENT |
| One tool call the model asked for | `execute_tool` | `execute_tool {gen_ai.tool.name}` | INTERNAL |
| An agent run, in your own process | `invoke_agent` | `invoke_agent {gen_ai.agent.name}` | INTERNAL |
| An agent run on a remote agent service | `invoke_agent` | `invoke_agent {gen_ai.agent.name}` | CLIENT |
| A process that coordinates several agents | `invoke_workflow` | `invoke_workflow {gen_ai.workflow.name}` | INTERNAL |
| An MCP request | (MCP: `mcp.method.name`) | `{mcp.method.name} {target}`, such as `tools/call get_weather` | CLIENT, or SERVER on the server side |

On a model span, `gen_ai.operation.name` and `gen_ai.provider.name` are Required. `gen_ai.request.model` is Conditionally Required when it is available. `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `gen_ai.response.finish_reasons` are Recommended. `error.type`, which is already Stable, is Required whenever the call failed. On a tool span, `gen_ai.tool.name` is Required; `gen_ai.tool.call.id` and `gen_ai.tool.type` are Recommended. The MCP page says its tool call spans "are compatible with GenAI execute_tool spans", so an agent's `execute_tool` span can sit directly above the `tools/call` CLIENT span to the MCP server.

<figure>
<svg viewBox="0 0 640 250" role="img" aria-labelledby="genai-fig-title genai-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="genai-fig-title">One agent run as GenAI spans</title>
  <desc id="genai-fig-desc">A tree of spans. invoke_agent support-bot at the top. Below it, a chat span for the first model call, an execute_tool span for the tool the model asked for, with a tools/call MCP client span under it, and a second chat span for the model call that writes the answer.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="15" width="600" height="34" rx="6" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="32" y="37">invoke_agent support-bot</text>
    <text x="608" y="37" text-anchor="end" font-size="12">INTERNAL · gen_ai.agent.name</text>
    <rect x="50" y="65" width="230" height="34" rx="6" fill="none" stroke="currentColor"/>
    <text x="62" y="87">chat gpt-4o</text>
    <text x="270" y="87" text-anchor="end" font-size="12">CLIENT</text>
    <rect x="290" y="115" width="300" height="34" rx="6" fill="none" stroke="currentColor"/>
    <text x="302" y="137">execute_tool lookup_order</text>
    <text x="580" y="137" text-anchor="end" font-size="12">INTERNAL</text>
    <rect x="320" y="165" width="270" height="34" rx="6" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <text x="332" y="187">tools/call lookup_order</text>
    <text x="580" y="187" text-anchor="end" font-size="12">CLIENT · mcp.*</text>
    <rect x="50" y="210" width="230" height="34" rx="6" fill="none" stroke="currentColor"/>
    <text x="62" y="232">chat gpt-4o</text>
    <text x="270" y="232" text-anchor="end" font-size="12">CLIENT</text>
    <path d="M40 49 L40 82 L50 82" stroke="currentColor" fill="none"/>
    <path d="M40 82 L40 132 L290 132" stroke="currentColor" fill="none"/>
    <path d="M40 132 L40 227 L50 227" stroke="currentColor" fill="none"/>
    <path d="M305 149 L305 182 L320 182" stroke="currentColor" fill="none"/>
  </g>
</svg>
<figcaption>Time runs downwards. The model asks for a tool, the agent runs it through an MCP server, and a second model call writes the answer. Each box is one span; the dashed one follows the MCP conventions.</figcaption>
</figure>

## The names that changed

Most confusion comes from guides and dashboards written against older releases. The main renames, all from the main repository's changelog:

| Older name | Current name (v1.41.0) | Changed in |
| --- | --- | --- |
| `gen_ai.system` | `gen_ai.provider.name` | 1.37.0 |
| `az.ai.openai`, `az.ai.inference` (values) | `azure.ai.openai`, `azure.ai.inference` | 1.35.0 |
| `gen_ai.usage.prompt_tokens` | `gen_ai.usage.input_tokens` | 1.27.0 |
| `gen_ai.usage.completion_tokens` | `gen_ai.usage.output_tokens` | 1.27.0 |
| Per-message events (`gen_ai.user.message`, `gen_ai.choice`, ...) | `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` attributes, or the `gen_ai.client.inference.operation.details` event | 1.37.0 |
| `gen_ai.openai.request.seed` | `gen_ai.request.seed` | 1.30.0 |
| Other `gen_ai.openai.*` attributes | `openai.*`, without the `gen_ai` prefix | 1.37.0 |

The `gen_ai.system` change is the one most readers trip over. The registry now lists it as deprecated, with the note "Deprecated, use `gen_ai.provider.name` instead." Under the transition plan above, instrumentation built on 1.36.0 or earlier keeps emitting `gen_ai.system` by default, and switches to `gen_ai.provider.name` only when you set `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`. If a dashboard groups by `gen_ai.system` and shows nothing, check which version your instrumentation emits before you suspect the export.

`gen_ai.provider.name` is a best guess by the instrumentation. The registry says it "may differ from the actual model provider". A call to a self-hosted server that speaks the OpenAI API is usually reported as `openai`, and `gen_ai.request.model`, `gen_ai.response.model` and `server.address` tell the real target apart. Well-known values include `openai`, `anthropic`, `azure.ai.openai`, `gcp.gemini`, `gcp.vertex_ai`, `aws.bedrock`, `mistral_ai` and `cohere`.

## Metrics: two generations

In v1.41.0 a client reports two histograms:

- `gen_ai.client.token.usage`, unit `{token}`, with `gen_ai.token.type` set to `input` or `output`. The conventions say an instrumentation that cannot get the counts "MUST NOT report usage metric", and that when a provider reports both used and billable tokens it "MUST report billable tokens".
- `gen_ai.client.operation.duration`, in seconds.

Both carry `gen_ai.operation.name`, `gen_ai.provider.name` and, when known, `gen_ai.request.model`, `gen_ai.response.model` and `server.address`. Release 1.41.0 also added streaming histograms for time to first chunk and time per output chunk.

The genai repository's main branch reorganises these. Inference durations move to `gen_ai.client.inference.duration`, and tokens become counters such as `gen_ai.client.inference.usage.input_tokens` and `gen_ai.client.inference.usage.output_tokens`, plus histograms per operation. Embeddings get their own `gen_ai.client.embeddings.duration`. Nothing from that branch has been released, so build on the v1.41.0 names and treat the new ones as an opt-in to test.

Keep ids off metrics. Execution, session and user ids on a metric create one series per run; put them on spans instead.

## Content is opt-in

Prompts and answers are not part of the default telemetry. Release 1.37.0 moved them to opt-in attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`) and said they "are not recorded by default when content capturing is disabled". Tool arguments and results (`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`) are opt-in too. If you turn content on, prompts with customer data leave your service for the tracing backend. Mask them first: [keeping personal data out of prompts, logs and traces](/learn/security/sensitive-data-in-prompts) covers how.

## How to map your own traces

Say your agent code already writes spans named `llm_request`, `agent_step` and `call_tool`, with attributes such as `model`, `vendor` and `prompt_tokens`. A mapping in five steps:

1. **Pin a version.** Choose v1.41.0 (the last release) and set the instrumentation scope's schema URL to `https://opentelemetry.io/schemas/1.41.0`, so a backend knows which names to expect.
2. **Rename spans and set the kind.** `llm_request` becomes `chat {model}` as a CLIENT span. Each tool call becomes `execute_tool {tool}`, INTERNAL. The loop around them becomes `invoke_agent {agent}`.
3. **Set the Required attributes.** `gen_ai.operation.name` on every span; `gen_ai.provider.name` on model spans; `gen_ai.tool.name` on tool spans; `error.type` on failures.
4. **Rename the rest, and keep your own under a prefix.** `prompt_tokens` becomes `gen_ai.usage.input_tokens`; `vendor` becomes `gen_ai.provider.name`. Fields the conventions do not define, such as a tenant id or a retry count, go under your own namespace (`acme.tenant.id`), never under `gen_ai.*`, where a later release might define the same name with another meaning.
5. **Put the switch in one place.** Keep every name in one module, as constants. When the genai repository releases, the move is one diff, and an opt-in setting lets you emit the new names in staging first.

For dashboards built on the old names, rename in the collector or in the backend's query for one release, then drop the alias.

Two cautions. Do not run a GenAI auto-instrumentation library over a client that you instrument yourself: every model call would be recorded twice. And use OpenTelemetry's span links, not parent and child, for work that resumes later, such as a run continued after a person approves a step. [Tracing vs logging for LLM apps](/learn/operations/tracing-vs-logging-for-llm-apps) covers what belongs on a span and what belongs in a log line.

## In L2M

L2M's OpenTelemetry export is optional and off by default. With an OTLP endpoint set, it emits these conventions itself, pinned at **v1.41.0**, with spans under the scope `l2m` and the schema URL `https://opentelemetry.io/schemas/1.41.0`. All the names live in one module of its `otel` package. What it emits ([OpenTelemetry](/operations/opentelemetry)):

- **Model calls**: `chat {model}` and `embeddings {model}` CLIENT spans, from one place in front of the provider adapters. The provider goes in `gen_ai.provider.name`, never `gen_ai.system`: `openai` (also for OpenAI-compatible servers, whose L2M id stays in `l2m.provider.id`), `azure.ai.openai`, `anthropic`, `gcp.gemini` and `ollama`; other providers use their L2M id ([model spans](/operations/opentelemetry#model-spans)).
- **Agents and tools**: `invoke_workflow` per run, `invoke_agent` per agent loop and `execute_tool` per tool call, with `gen_ai.tool.type` set to `extension` for an MCP server's tool and `function` for one that runs inside L2M. The workflow's name goes in `l2m.workflow.name`; L2M does not set `gen_ai.workflow.name`. MCP requests get `tools/call {tool}` CLIENT spans under the `execute_tool` span, and the MCP gateway gets SERVER spans.
- **Metrics**: `gen_ai.client.operation.duration` and `gen_ai.client.token.usage` by default. `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` switches to the main-branch names, such as `gen_ai.client.inference.duration`. Spend goes in L2M's own `l2m.gen_ai.cost` counter ([GenAI and cost metrics](/operations/opentelemetry#genai-and-cost-metrics)).
- **Content**: none by default. `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` turns on the opt-in content attributes, masked and cut to size before export ([content capture](/operations/opentelemetry#content-capture)).

L2M's own steps that the conventions do not cover, such as workflow nodes and queue jobs, use `l2m.*` names. The [OpenTelemetry tracing post](/blog/opentelemetry-tracing-for-ai-agents) explains why the spans are cut this way.

**Try it.** Follow the [quick start with a local collector](/operations/opentelemetry#quick-start-with-a-local-collector): start the collector, run the zero-key MCP Agent Quickstart template, and read the span and metric names in `ops/otel/otel-data/traces.jsonl`. Its echo model makes no tool calls, so you will see `invoke_agent`, `chat` and the MCP `tools/list` span, but no `execute_tool`.

## Further reading

- [Semantic conventions v1.41.0: GenAI overview](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/README.md) (OpenTelemetry): status and the transition plan
- [v1.41.0: GenAI model spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-spans.md) and [agent spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-agent-spans.md) (OpenTelemetry)
- [v1.41.0: GenAI metrics](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-metrics.md) and [MCP](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/mcp.md) (OpenTelemetry)
- [v1.41.0: GenAI attribute registry](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/registry/attributes/gen-ai.md) (OpenTelemetry): deprecated attributes and their replacements
- [Semantic conventions changelog](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/CHANGELOG.md) (OpenTelemetry): the 1.37.0 renames
- [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) (OpenTelemetry): where the conventions are maintained now
- [Maturity levels](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/maturity-levels.md) (OpenTelemetry specification): what Development means
- L2M docs: [OpenTelemetry](/operations/opentelemetry), [Observability](/operations/observability)
