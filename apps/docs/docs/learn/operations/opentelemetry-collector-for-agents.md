---
title: "Send AI agent traces to an OpenTelemetry Collector"
sidebarTitle: "Agent traces in a Collector"
description: "A Collector pipeline for agent traces: memory limits, deleting prompt attributes, export to Jaeger, reading spans, trace context into MCP."
level: intermediate
about: opentelemetry
related: [opentelemetry, genai-semantic-conventions, trace-context-propagation, masking, mcp-client]
---

# Send AI agent traces to an OpenTelemetry Collector

Point the agent runtime's OTLP exporter at an <Term id="opentelemetry">OpenTelemetry</Term> Collector, let the Collector limit memory, delete any prompt and completion attributes and batch the spans, then export them to a tracing backend such as Jaeger. One agent run becomes one trace: the run, each node, the agent loop, each model call and each MCP request, with token counts and outcomes but no content. Prompts reach the trace only if you turn content capture on, and the Collector can strip them again before they leave your network.

This guide builds that pipeline, reads a real L2M trace span by span, and shows how the trace continues into the MCP servers an agent calls. For every L2M setting, see the [OpenTelemetry reference](/operations/opentelemetry). For why the spans are shaped this way, see the blog post [Tracing AI agents with OpenTelemetry, end to end](/blog/opentelemetry-tracing-for-ai-agents).

## Why a Collector and not a direct export

L2M can export straight to any OTLP endpoint. A Collector in between is still worth running, for three reasons:

- **Policy in one place.** Deleting attributes, sampling and routing happen in the Collector's config, not in each application. When the GenAI conventions rename an attribute, you change one file.
- **A second line of defence for content.** L2M records no prompts by default and masks them when you opt in. A Collector rule that deletes the content attributes means a wrong setting on one instance cannot leak prompts to the backend.
- **Back-pressure and retries.** The Collector buffers, retries and protects itself with a memory limit, so a slow backend does not become the application's problem.

## Step 1: run Jaeger and the Collector

Jaeger is an open-source tracing backend that accepts OTLP natively: gRPC on port 4317 and HTTP on 4318 (`/v1/traces`). Its all-in-one image keeps traces in memory, which is fine for trying this out:

```bash
docker network create tracing
docker run -d --name jaeger --network tracing \
  -p 127.0.0.1:16686:16686 \
  cr.jaegertracing.io/jaegertracing/jaeger:2.23.0
```

The UI is at `http://localhost:16686`. Jaeger's port 4317 stays inside the Docker network: only the Collector talks to it.

Save this as `collector.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 400
    spike_limit_mib: 80
  transform/drop-genai-content:
    error_mode: ignore
    trace_statements:
      - delete_matching_keys(span.attributes, "^gen_ai\\.(system_instructions|input\\.messages|output\\.messages|tool\\.definitions|tool\\.call\\.arguments|tool\\.call\\.result)$")
      - delete_matching_keys(spanevent.attributes, "^gen_ai\\.(system_instructions|input\\.messages|output\\.messages|tool\\.definitions)$")
  attributes/drop-client-address:
    actions:
      - key: client.address
        action: delete
  batch: {}

exporters:
  otlp_grpc/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, transform/drop-genai-content, attributes/drop-client-address, batch]
      exporters: [otlp_grpc/jaeger]
```

Check it and start the Collector, pinned to release v0.165.0 (7 November 2026):

```bash
docker run --rm -v "$PWD/collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.165.0 validate --config=/etc/otelcol-contrib/config.yaml

docker run -d --name otelcol --network tracing \
  -p 127.0.0.1:4318:4318 \
  -v "$PWD/collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.165.0
```

`validate` prints nothing and exits 0 when the file is good, and names the component when it is not. We ran this exact file through `validate` and through a live Collector and Jaeger pair while writing this guide.

### What each part does

| Component | Why it is there |
|---|---|
| `otlp` receiver, HTTP only | L2M exports OTLP over HTTP (`http/protobuf` by default, or `http/json`) and does not ship gRPC, so 4318 is the only port needed. Inside a container `0.0.0.0` is needed for the published port to work; the Collector's own docs prefer `localhost` when every client is on the same host. |
| `memory_limiter` | Refuses data when the Collector nears its limit, so it slows senders instead of crashing. Its README says to make it the first processor. Size `limit_mib` to the container's memory. |
| `transform/drop-genai-content` | Deletes the GenAI content attributes from spans and from span events. L2M can put model content on a `gen_ai.client.inference.operation.details` event, so deleting span attributes alone is not enough. |
| `attributes/drop-client-address` | An example of deleting one attribute by name. `client.address` is the caller's IP on HTTP server spans; drop it if your backend should not hold IP addresses. |
| `batch` | Groups spans into fewer, larger exports. |
| `otlp_grpc/jaeger` | Sends to Jaeger over OTLP gRPC. `insecure: true` turns TLS off, which is only acceptable on a private network like this one. |

In Collector v0.165.0 the OTLP gRPC exporter's type is `otlp_grpc` and the HTTP one is `otlp_http`; the older `otlp` and `otlphttp` names are still accepted. The `transform` and `attributes` processors are in the contrib distribution and are marked beta.

## Step 2: point L2M at the Collector

Tracing is off in L2M until you set an endpoint. With the Collector on the same host:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=l2m \
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=dev \
L2M_OTEL_TRACE_URL_TEMPLATE='http://localhost:16686/trace/{traceId}' \
pnpm dev:product
```

L2M adds `/v1/traces` to the combined endpoint itself. Use port 4318, not 4317: `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` stops the API at start-up. Spans leave in batches every 5 seconds, so wait a moment before you look. With the trace URL template set, each traced run page in L2M gets an **Open trace** link straight to Jaeger.

Run any workflow. The zero-key **MCP Agent Quickstart** template works without a model key: it uses the built-in echo model and mock MCP server.

## Step 3: read an agent trace span by span

This is the trace L2M exported for a run of that quickstart shape, as Jaeger received it (attributes shortened). The echo model never asks for tools, so there is no `execute_tool` span in it; a real model that calls a tool adds the lines shown after it.

```
POST /api/workflows/:id/execute        SERVER   32 ms  http.route, http.response.status_code=200
└─ invoke_workflow OTel smoke agent    INTERNAL 26 ms  l2m.execution.id, l2m.trigger.type=manual, l2m.run.status=success
   ├─ l2m.node manual_trigger          INTERNAL  3 ms  l2m.node.status=success
   ├─ l2m.node agent_orchestrator      INTERNAL 17 ms
   │  ├─ tools/list                    CLIENT          mcp.method.name=tools/list, l2m.mcp.server.id=mock-mcp
   │  └─ invoke_agent Agent            INTERNAL 12 ms  l2m.agent.iterations=1, l2m.agent.stop_reason=final_answer
   │     └─ chat demo                  CLIENT          gen_ai.provider.name=echo, gen_ai.request.model=demo,
   │                                                   gen_ai.usage.input_tokens=4, gen_ai.usage.output_tokens=6
   └─ l2m.node output                  INTERNAL  0 ms

With a model that calls a tool, under invoke_agent:
         ├─ chat {model}               CLIENT   the model asks for a tool
         ├─ execute_tool {tool}        INTERNAL gen_ai.tool.name, l2m.tool.outcome=ok
         │  └─ tools/call {tool}       CLIENT   mcp.method.name, mcp.session.id, network.transport
         └─ chat {model}               CLIENT   the final answer
```

Read it from the top:

1. **The HTTP span** is the request that started the run. A run started by a schedule or trigger has no HTTP parent; a queued run has a `process l2m.queue` CONSUMER span instead.
2. **`invoke_workflow`** is the run. `l2m.execution.id` takes you to the run in L2M. `l2m.run.status` holds the outcome. A paused or canceled run is not an error: only a failed run sets the span status to ERROR.
3. **`l2m.node {type}`** is one span per node that ran. Nodes on the agent's attachment ports (chat model, memory, tools) get no span of their own: their work appears inside the agent's spans.
4. **`tools/list`** sits under the agent node: the agent asked each attached MCP server for its tools before the loop started.
5. **`invoke_agent {name}`** is the loop. `l2m.agent.iterations` and `l2m.agent.stop_reason` tell you whether it finished or hit its limit, and the summed `gen_ai.usage.*` tokens give the cost of the whole loop. `gen_ai.conversation.id` is the memory session id; L2M hashes it when it looks like an email address or phone number.
6. **`chat {model}`** is one model call, with the provider, model, finish reasons and token counts from the provider's answer. OpenAI-compatible servers report `gen_ai.provider.name=openai` and keep their L2M id in `l2m.provider.id`.
7. **`execute_tool {tool}`** is one tool call the model asked for, and **`tools/call {tool}`** under it the request that went to the MCP server. `l2m.tool.outcome` is `ok`, `error`, `blocked` or `paused`; a call stopped by a tool rule is an outcome, not an error.

Questions this answers quickly in Jaeger: which tool call took the time (compare `tools/call` durations), how many turns the agent needed (`l2m.agent.iterations`), whether the slow part was the model or the server (`chat` versus `tools/call`), and which runs failed (search for `error=true`). Errors carry a type only, such as `timeout` or `tool_error`, never the server's or provider's error text.

The names follow the OpenTelemetry <Term id="genai-semantic-conventions">GenAI semantic conventions</Term> and the MCP conventions, both marked **Development** in semantic-conventions v1.41.0, the release L2M pins. Development means the names can still change. Dashboards built on `gen_ai.*` attributes should expect a rename one day; L2M keeps the names in one module and notes any move in its changelog. The GenAI text has since moved to its own repository, `open-telemetry/semantic-conventions-genai`.

## Step 4: trace context into MCP servers

<Term id="trace-context-propagation">Trace context propagation</Term> carries the trace id from one process to the next, using the W3C Trace Context `traceparent` value:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             version-trace id-parent span id-flags (01 = sampled)
```

MCP itself defines no trace header. The OpenTelemetry MCP conventions say instrumentations SHOULD put the context in the request's `params._meta`, and that is what L2M does while tracing is on. A `tools/call` request to a server looks like this:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "search_tickets",
    "arguments": { "query": "refund" },
    "_meta": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-5b8aa5a2d2c872e8-01"
    }
  }
}
```

What L2M sends, checked against `packages/mcp-sdk/src/tracing.ts`:

- `traceparent` (and `tracestate` when the trace has one) in `params._meta` on every MCP request, over stdio and HTTP and for both protocol eras; `baggage` too when `OTEL_PROPAGATORS` includes it.
- Over HTTP, the same values as request headers. The `initialize` request carries them in headers only, and over stdio it carries none.
- The parent span id is the `tools/call` CLIENT span, so a server that continues the context hangs its own spans under that call.
- The context is merged with other `_meta` keys such as the progress token, never replacing them.

A server built with an OpenTelemetry SDK can read `params._meta.traceparent`, extract it as the remote parent and start its server span there; its spans then sit under `tools/call` in Jaeger. A server that does nothing with it ignores the key.

Two switches turn it off. A server that rejects unknown fields: untick **Send trace context** in its connection settings, or set `"propagateTraceContext": false` in its connection JSON. Every server: `L2M_OTEL_PROPAGATE_TO_MCP=false`. Model providers get no `traceparent` unless you set `L2M_OTEL_PROPAGATE_TO_PROVIDERS=true`, because their endpoints are outside your trace domain.

In the other direction, a caller's `traceparent` is continued only when the caller is trusted. By default (`L2M_OTEL_TRUST_INBOUND=authenticated`) that means a request with a valid session, API key or gateway token; an anonymous webhook caller gets a new trace with a link to theirs.

## Keep prompts out unless you opt in

By default L2M records ids, timings, token counts and outcomes. Prompts, answers, tool arguments and tool results stay in L2M's run history. That is the right default for most teams: a tracing backend usually has wider access and longer retention than the system that holds the data.

Content capture is opt-in, with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT`:

| Value | What the spans carry |
|---|---|
| `NO_CONTENT` (default) | No content |
| `SPAN_ONLY` | Content attributes on `chat` and `execute_tool` spans |
| `EVENT_ONLY` | A `gen_ai.client.inference.operation.details` event on each `chat` span |
| `SPAN_AND_EVENT` | Both |

When it is on, L2M removes secret values, replaces what <Term id="masking">masking</Term> and [content rules](/product/content-rules-engine) detect with stable surrogates, and cuts long values before export. Content from a run marked sensitive is left out, with `l2m.content.dropped` saying why. It needs `SECRET_MASTER_KEY_BASE64`, and `/v1` gateway requests need `L2M_OTEL_CAPTURE_GATEWAY_CONTENT=true` as well.

The Collector rule from Step 1 decides what reaches the backend regardless. A common split:

- **Production pipeline:** keep `transform/drop-genai-content`. Even if someone turns capture on, the content stops at the Collector.
- **Debug pipeline:** a second Collector, or a second pipeline with its own receiver port, without the rule, exporting to a backend with short retention and narrow access. Turn capture on only on the instances that send there.

We tested the rule by sending L2M's exported trace through the Collector with a `gen_ai.input.messages` attribute and a `gen_ai.output.messages` event attribute added to the `chat` span: both arrived in Jaeger removed, while the token counts and the event's `gen_ai.response.id` stayed.

Workflow, node and agent names are not content but can still say more than you want. `L2M_OTEL_NAMES=ids` puts ids in their place.

## Production notes

- **Sampling.** Use `OTEL_TRACES_SAMPLER=parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG=0.1` for a fixed share of traces, and do tail sampling (such as "keep every trace with an error") in the Collector.
- **Volume.** A run produces one span per node that ran, plus one per agent loop, model call, tool call and MCP request. `L2M_OTEL_SPAN_DETAIL=verbose` adds a span per agent turn; leave it at `standard` unless you need it.
- **Security.** Put the Collector on a private network, use TLS to the backend, and send a token with `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20<token>` if the Collector requires one.
- **Metrics.** Add `OTEL_METRICS_ENABLED=true` and a `metrics` pipeline to the Collector for `gen_ai.client.token.usage`, `mcp.client.operation.duration` and the cost counter.

## Try it in L2M

<TryInDemo workflow="wf-mcp-agent-quickstart" />

The live demo has no tracing backend. To see the trace above, run L2M locally with the commands in Steps 1 and 2 and run the **MCP Agent Quickstart** template, or run `node scripts/otel-smoke.mjs`, which checks the whole export path with its own receiver.

## Further reading

- [OpenTelemetry Collector configuration](https://opentelemetry.io/docs/collector/configuration/) (opentelemetry.io)
- [Transform processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/transformprocessor/README.md), [attributes processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/attributesprocessor/README.md) and [memory limiter](https://github.com/open-telemetry/opentelemetry-collector/blob/main/processor/memorylimiterprocessor/README.md) (GitHub, OpenTelemetry)
- [Jaeger: getting started](https://www.jaegertracing.io/docs/latest/getting-started/) and [APIs (OTLP)](https://www.jaegertracing.io/docs/latest/architecture/apis/) (jaegertracing.io)
- [GenAI semantic conventions v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/README.md) and [MCP conventions v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/mcp.md) (GitHub, OpenTelemetry)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) (w3.org, Recommendation)
- L2M docs: [OpenTelemetry reference](/operations/opentelemetry), [Observability](/operations/observability), blog: [Tracing AI agents with OpenTelemetry](/blog/opentelemetry-tracing-for-ai-agents) and [Keeping sensitive data out of traces](/blog/keeping-sensitive-data-out-of-traces)
