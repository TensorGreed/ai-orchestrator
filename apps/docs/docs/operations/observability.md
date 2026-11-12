---
title: "Observability: logs, metrics and OTLP traces"
description: "Observability for self-hosted L2M: JSON logs with request and trace IDs, Prometheus metrics, OTLP traces and metrics, and SLO budgets, all opt-in."
---

# Observability

L2M can run in production with standard tooling: JSON request logs, Prometheus metrics, OpenTelemetry traces and metrics over OTLP, and SLO budgets. Everything beyond the logs and `/metrics` is opt-in through environment variables, and a deployment that sets none of them runs exactly as before.

## What's emitted

| Signal | Source | Where it lives |
|---|---|---|
| **Logs** | Pino, through Fastify's request logger | stdout (JSON). Every line written while handling a request carries `reqId`. With tracing on, those lines also carry `trace_id` and `span_id`. |
| **Metrics** | `MetricsService` | `GET /metrics` (Prometheus exposition), always on. Optionally pushed over OTLP. |
| **Traces** | OpenTelemetry SDK, loaded only when tracing is on | Exported over OTLP to the endpoint you set. The last 5,000 spans of each instance are also kept in memory for `GET /api/observability/traces`. |

Traces and OTLP metrics go to any OTLP-compatible backend, or to an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) that forwards them.

### What is traced today

- **One SERVER span per HTTP request**, named `{method} {route}` (for example `POST /api/workflows/:id/execute`), with the stable HTTP attribute names listed [below](#http-server-spans). `/health`, `/ready` and `/metrics` get no span.
- **Workflow runs, nodes, agents and tool calls**: one `invoke_workflow` span per run, one span per node that ran, `invoke_agent` per Agent or Supervisor loop and `execute_tool` per tool call the model made. See [run spans](#run-spans).
- **Model calls**: one `chat {model}` or `embeddings {model}` CLIENT span per call to a model provider, from a run, the `/v1` AI gateway or anywhere else, with token usage. See [model spans](#model-spans).
- **MCP calls and the MCP gateway**: a CLIENT span per request L2M sends to an MCP server, a SERVER span per request the gateway answers, and trace context sent on to MCP servers. See [MCP spans](#mcp-spans-and-trace-context).
- **Queue jobs and approval resumes**: a worker's job continues the trace of whoever enqueued it, on any instance, and a resume after an approval links back to the node that paused. See [queues, clusters and approvals](#queues-clusters-and-approvals).
- L2M does **not** send `traceparent` to model providers unless `L2M_OTEL_PROPAGATE_TO_PROVIDERS=true`.

## Quickstart: send traces to a collector

Set one variable. Everything else has a default.

```bash
# Combined endpoint: traces go to /v1/traces, metrics to /v1/metrics
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318

# Optional: describe the deployment on every span and metric
OTEL_SERVICE_NAME=ai-orchestrator
OTEL_SERVICE_VERSION=0.1.0
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,team=platform

# Optional: also push metrics (traces are on whenever an endpoint is set)
OTEL_METRICS_ENABLED=true
OTEL_METRICS_PUSH_INTERVAL_MS=60000
```

A minimal collector configuration that receives both OTLP/HTTP encodings:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
```

To send traces and metrics to different places, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. A per-signal endpoint is used as it is (include the `/v1/traces` path); it overrides the combined one.

`TRACING_ENABLED=true` with no endpoint records spans in the in-memory buffer only, which is useful for looking at `/api/observability/traces` without a collector.

## Metrics over OTLP

With `OTEL_METRICS_ENABLED=true` and an endpoint (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, or `OTEL_EXPORTER_OTLP_ENDPOINT`, which also turns tracing on), L2M exports metrics through the OpenTelemetry SDK every `OTEL_METRICS_PUSH_INTERVAL_MS` (60 seconds by default), with the same protocol, headers and timeout as traces, and once more on a clean stop. A metrics endpoint **does not turn tracing on**: with only `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_METRICS_ENABLED=true`, only the metrics pipeline runs (no spans, no HTTP hooks, no context propagation).

The metric names are the ones L2M has always pushed, as cumulative sums (counters) and gauges, so existing dashboards keep working:

| Name | Kind |
|---|---|
| `ao.http.requests.total`, `ao.workflow.executions.total`, `ao.workflow.executions.success.total`, `ao.workflow.executions.failure.total` | Sum (monotonic, cumulative) |
| `ao.workflow.executions.active`, `ao.slo.success.rate`, `ao.slo.healthy`, `ao.uptime.seconds` | Gauge |
| `ao.workflow.execution.duration.p50.ms`, `.p95.ms`, `.p99.ms`, `ao.http.request.duration.p50.ms`, `.p95.ms` | Gauge, **deprecated**: use the histograms |
| `ao.workflow.execution.duration` (unit `s`, attribute `l2m.execution.status`) | Histogram, new |
| `ao.http.request.duration` (unit `s`, attributes `http.request.method`, `http.response.status_class`) | Histogram, new |
| `l2m_otel_spans_dropped_total` (attribute `reason=export_failed`) | Sum, new; counted while spans are exported, and visible only with a metrics endpoint |
| `gen_ai.client.operation.duration` (s) and `gen_ai.client.token.usage` ({token}) | Histograms, new: the [GenAI metrics](#genai-and-cost-metrics) |
| `l2m.gen_ai.cost` (USD) | Sum, new: priced model spend |
| `mcp.client.operation.duration` and `mcp.server.operation.duration` (s) | Histograms, new: the [MCP metrics](#mcp-spans-and-trace-context), recorded only while tracing is on |

Differences from the previous push: the default encoding is `http/protobuf` (set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` for the old one), the instrumentation scope stays `ai-orchestrator`, and values are exported from the same counters the Prometheus `/metrics` page reads, which are unchanged. The percentile gauges are kept for one release and then removed; the histograms replace them. With `METRICS_ENABLED=false` the counters stay at zero and the histograms get no observations. Spans lost when the queue is full, or still being exported when a shutdown times out, are not counted: only those lost to a failed export.

## Export

- **Protocol.** `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/protobuf` (the default, as in the OpenTelemetry specification) or `http/json`, for traces and for metrics. Collectors listening on port 4318 accept both. gRPC is not shipped: `grpc` with a traces or a metrics endpoint in use stops the API at start-up.
- **Batching.** Spans are exported in batches by the SDK's batch span processor, never one request per span. The `OTEL_BSP_*` variables tune it (see the [settings table](#settings)). When the queue is full, new spans are dropped rather than slowing requests down.
- **Unreachable collector.** An export that fails or takes longer than `OTEL_EXPORTER_OTLP_TIMEOUT` (10 seconds by default) is dropped. Exporting never blocks a request.
- **Shutdown.** On a clean stop, L2M flushes the spans still queued, waiting at most 5 seconds.

### Auth headers

`OTEL_EXPORTER_OTLP_HEADERS` is a comma-separated `key=value` list added to every OTLP request, for a backend or collector that needs a token or a tenant id. Values are percent-decoded, as the specification asks, so encode a space as `%20` and a comma as `%2C`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20YOUR_TOKEN,x-tenant=l2m-prod
```

Header values are never shown by the API: `GET /api/observability` lists header names only. They are also removed from error messages recorded on spans.

## Resource attributes

Every span and metric carries:

- `service.name`: `OTEL_SERVICE_NAME`, else `TRACING_SERVICE_NAME` (default `ai-orchestrator`). `OTEL_SERVICE_NAME` wins over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.
- `service.version`: `OTEL_SERVICE_VERSION`, if set.
- `telemetry.sdk.name`, `telemetry.sdk.language` and `telemetry.sdk.version`, set by the OpenTelemetry SDK.
- `host.name` (the machine's host name), `process.pid` and `service.instance.id` (a random id per start), so replicas can be told apart.
- Every `key=value` pair in `OTEL_RESOURCE_ATTRIBUTES`; it overrides any of the above except `service.name`. Set `deployment.environment.name` here.

## Sampling

`OTEL_TRACES_SAMPLER` takes the specification's built-in samplers: `always_on`, `always_off`, `traceidratio`, `parentbased_always_on` (the default), `parentbased_always_off` and `parentbased_traceidratio`. The two ratio samplers read `OTEL_TRACES_SAMPLER_ARG`, a number from 0 to 1; without it (or with a value outside that range) they sample every trace, as the specification says, and the API logs a warning. An unknown sampler falls back to the default with a warning.

To bound volume on a busy deployment, use `parentbased_traceidratio` with a small ratio, and keep tail sampling (for example "keep every trace with an error") in the collector.

## Inbound trace context and who is trusted

A caller can send a W3C `traceparent` header (and `tracestate`). Whether L2M continues that trace depends on who the caller is, set by `L2M_OTEL_TRUST_INBOUND`:

| Value | Behaviour |
|---|---|
| `authenticated` (default) | The trace continues (and its sampled flag is honoured) when the request carries a valid credential: a live signed-in session, an unexpired API key (whatever its scopes), or an MCP / AI gateway client token. It also continues for connections from `L2M_OTEL_TRUSTED_PROXIES`. Anyone else's request starts a new trace with a **link** to theirs. |
| `all` | Every caller's trace continues. Use only when the API is reachable solely through your own services. |
| `none` | No caller's trace continues; every request starts a new trace that links to the caller's. |

This stops an anonymous caller (a public webhook, for example) from switching sampling on or off for your traces, or from making your spans part of their trace. The credential check only reads the credential: it records no key or token use, does not count as session activity and ends no session, and the route still authenticates (and authorizes) the request as usual. Holding any valid credential is enough to continue a trace, even one that the route then refuses for lack of permission.

`L2M_OTEL_TRUSTED_PROXIES` is a comma list of IP addresses or CIDR ranges. It is matched against the address that opened the connection (not `X-Forwarded-For`), so list the proxy or gateway in front of L2M that passes on your own services' trace context. Every request arriving through a listed address is trusted, so do not list an internet-facing load balancer or ingress: that trusts every caller on the internet, as `all` does.

`OTEL_PROPAGATORS` chooses the formats read from callers and sent to MCP servers: `tracecontext` (default), `baggage`, or `none` to ignore inbound context entirely. An unsupported entry is ignored with a warning. Baggage is never copied into span attributes.

## Trace ids in logs

While tracing is on, each request's log lines (from the tracing hook onwards, including Fastify's `request completed` line) carry `trace_id` and `span_id` next to `reqId`. Other lines written inside a span carry `trace_id`, `span_id` and `trace_flags`. Search your logs for a trace id to find every line of that request. The `incoming request` line is written before the span starts and has `reqId` only.

With tracing off, log lines are unchanged.

## HTTP server spans

`OTEL_HTTP_SERVER_SPANS` (default `true`) records one SERVER span per request while tracing is on, from the tracing hook onwards. A request refused earlier (by network rules or a rate limit) gets no span. With tracing off, no hooks are installed at all. Attributes follow the stable HTTP semantic conventions:

| Attribute | Value |
|---|---|
| `http.request.method` | `GET`, `POST`, ..., or `_OTHER` (with `http.request.method_original`) |
| `http.route` | The matched route pattern, such as `/api/workflows/:id` |
| `url.path` | The request path, without the query string |
| `url.scheme` | `http` or `https` |
| `client.address` | The client address (honours `TRUST_PROXY`) |
| `http.response.status_code` | The response status |
| `error.type` | The status code, for 5xx responses only |
| `l2m.request.id` | The request id, also in `reqId` and the `X-Request-ID` response header |

A 5xx response sets the span status to ERROR; a 4xx leaves it unset. A request that matched no route is named after its method alone.

## Run spans

While tracing is on, every workflow run is traced below the request (or the trigger) that started it. Span names and the GenAI attributes follow the OpenTelemetry GenAI semantic conventions pinned at v1.41.0, which are still marked experimental upstream.

```
POST /api/workflows/:id/execute         SERVER
└─ invoke_workflow {workflow name}      the run
   ├─ l2m.node {node type}              one per node that ran
   │  └─ invoke_workflow {child name}   an Execute Workflow node's child run
   └─ l2m.node agent_orchestrator
      └─ invoke_agent {agent name}      the agent loop
         ├─ l2m.agent.iteration         one per turn (L2M_OTEL_SPAN_DETAIL=verbose only)
         └─ execute_tool {tool name}    one per tool call the model made
            └─ invoke_agent {worker}    a Supervisor's worker, under the call that delegated to it
```

- **Nodes.** Only nodes the run reached get a span; a node answered from pinned data gets one too, with no children. Skipped nodes (a branch not taken, a disconnected node) and nodes on an agent's attachment ports (chat model, memory, tools, workers) get none: they are not steps of the workflow, and their work shows up inside the agent's spans. A Loop node's body nodes are children of the Loop node's span, one per pass, with `l2m.node.loop_index`.
- **Outcomes, not errors.** `l2m.run.status` and `l2m.node.status` hold the result (`success`, `error`, `canceled`, `waiting_approval`, ...). Only a failed run or node sets the span status to ERROR, with the L2M error category as `error.type` (the error text stays in the run's history); a canceled run and an approval pause are not errors. A node that failed but let the run continue is ERROR while its run is not. When a run is stopped or times out, the node, Loop pass or tool call that was in flight can show as ERROR while the run is `canceled`.
- **Resumed runs.** A run resumed after an approval is traced as a new run, linked to the node that paused ([below](#queues-clusters-and-approvals)); the decided Human Approval node itself gets no span in it.
- **Tool calls.** `l2m.tool.outcome` is `ok`, `error`, `blocked` or `paused`. A call that content rules or a tool policy blocked is an outcome, not an error (a node that fails because content rules blocked it is an error of that node); `l2m.content_rules.outcome` (`blocked`, `rewritten`, `paused`) says what content rules did. A failed call records its error type only, never the tool's error text. `gen_ai.tool.type` is `extension` for an MCP server's tool and `function` for one that runs in L2M (a worker, a workflow tool, a built-in or internal tool, with `l2m.tool.internal` for the internal ones).
- **Names.** Workflow, node and agent names appear in span names and attributes. `L2M_OTEL_NAMES=ids` uses ids instead.

| Span | Attributes |
|---|---|
| `invoke_workflow` | `gen_ai.operation.name`, `l2m.execution.id`, `l2m.workflow.id`, `l2m.workflow.name`, `l2m.project.id`, `l2m.trigger.type`, `l2m.run.mode`, `l2m.replay`, `l2m.run.status` |
| `l2m.node` | `l2m.node.id`, `l2m.node.type`, `l2m.node.name`, `l2m.node.status`, `l2m.node.attempts`, `l2m.node.loop_index` |
| `invoke_agent` | `gen_ai.operation.name`, `gen_ai.agent.id` (the node id), `gen_ai.agent.name`, `gen_ai.conversation.id` (the memory session id; hashed when it looks like an email address or phone number), `l2m.agent.supervisor`, `l2m.agent.iterations`, `l2m.agent.stop_reason`, summed `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `gen_ai.usage.cache_read.input_tokens` |
| `l2m.agent.iteration` | `l2m.agent.iteration`, `l2m.agent.final` |
| `execute_tool` | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `l2m.tool.internal`, `l2m.tool.outcome`, `l2m.content_rules.outcome` |

Spans carry ids and timings, not content: prompts, tool arguments and results stay in L2M's execution history. Use `l2m.execution.id` to go from a trace to the run in L2M.

## Model spans

While tracing is on, every call L2M makes to a model provider gets a CLIENT span: `chat {model}` for a chat call and `embeddings {model}` for an embeddings call. The spans come from one place in front of the provider adapters, so every caller is covered once: LLM Call nodes, agent loops, the `/v1` AI gateway, content rule checks that call a model, evals and gateway sampling. The embedders of RAG and knowledge-base nodes call their providers directly and get no span yet. In a run, a call sits under its node's span, or under `invoke_agent` (or its turn, at verbose detail) for an agent loop.

```
POST /v1/chat/completions               SERVER  l2m.gateway.* attributes
└─ chat {model}                         CLIENT  one per model call
```

| Span | Attributes |
|---|---|
| `chat` | `gen_ai.operation.name`, `gen_ai.provider.name`, `l2m.provider.id`, `gen_ai.request.model`, `gen_ai.request.stream`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `server.address`, `server.port`, `l2m.retry.count`, `l2m.stream.closed_early` |
| `embeddings` | the same request and usage attributes, plus `gen_ai.embeddings.dimension.count` |

- **Providers.** `gen_ai.provider.name` uses the well-known values: `openai` (also for OpenAI-compatible servers, whose L2M id stays in `l2m.provider.id`), `azure.ai.openai`, `anthropic`, `gcp.gemini` and `ollama`. `server.address` is the provider's host, never its URL.
- **Streams.** A streamed answer's span stays open until the stream ends, and takes the usage and finish reason from its last chunks. When the reader stops early (the caller hung up, content rules cut the answer), the span ends then with `l2m.stream.closed_early`.
- **Failures and refusals.** A failed call sets the span status to ERROR with its type as `error.type` (the L2M error category, such as `timeout` or `model_not_allowed`, else the error's class), never the provider's error text. A call the model allowlist refuses gets a span with `error.type=model_not_allowed`, though nothing was sent; it is left out of the metrics.
- **No content.** Prompts, answers, tool definitions and tool arguments are never recorded on these spans.
- **`/v1` requests.** The gateway puts its ids and outcome on the request's HTTP span: `l2m.gateway.request.id` (the id of the request's usage row), `l2m.gateway.route_set.id`, `l2m.gateway.route.alias`, `l2m.gateway.client.id`, `l2m.gateway.status` (the usage row's status, or the refusal: `rate_limited`, `budget_blocked`, `model_not_allowed`) and `l2m.content_rules.outcome` (`blocked` or `rewritten`). A refused request has no `chat` span: no model was called.
- **Propagation.** L2M does not send `traceparent` to model providers by default: their endpoints are outside your trace domain. `L2M_OTEL_PROPAGATE_TO_PROVIDERS=true` adds it (and `tracestate`) to each provider request, for a provider or proxy you run yourself.

## GenAI and cost metrics

With metrics exported (`OTEL_METRICS_ENABLED=true` and a metrics endpoint; tracing need not be on), every model call also feeds the GenAI client metrics, and priced spend feeds a counter:

| Name | Kind | Attributes |
|---|---|---|
| `gen_ai.client.operation.duration` | Histogram, s | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `server.address`, `server.port`, `error.type` on failures |
| `gen_ai.client.token.usage` | Histogram, {token} | the same, plus `gen_ai.token.type` (`input` or `output`); only counts the provider reported |
| `l2m.gen_ai.cost` | Sum, USD | `gen_ai.provider.name`, `gen_ai.request.model`, `l2m.project.id`, `l2m.usage.source` (`run` or `ai_gateway`) |

- **Cost is not priced twice.** `l2m.gen_ai.cost` is added where L2M already prices usage: when a run's usage event is written and when a `/v1` request's usage row is written, with the same pricing table. Those rows stay the record for spend, budgets and FinOps; the metric is an operational mirror that a collector may sample or drop. Unpriced models add nothing.
- **No per-run ids on metrics.** Execution, workflow, node, session and client ids are on spans only.
- **Newer names.** The GenAI conventions are still experimental, and their newer, unreleased text renames these metrics. `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` switches to those names: chat calls report `gen_ai.client.inference.duration`, the counters `gen_ai.client.inference.usage.input_tokens`, `.output_tokens` and `.cache_read.input_tokens` (with `gen_ai.token.modality=unknown`, since providers report totals) and the histograms `gen_ai.client.inference.operation.input_tokens` and `.output_tokens`; embeddings calls report `gen_ai.client.embeddings.duration` and `gen_ai.client.embeddings.operation.input_tokens`. These names may change again before that text is released. The cost counter is the same in both modes.

## MCP spans and trace context

While tracing is on, MCP traffic is traced in both directions, for servers on either protocol era (the `initialize` handshake or 2026-07-28). Names and attributes follow the OpenTelemetry MCP semantic conventions pinned at v1.41.0, which are still marked experimental upstream.

```
execute_tool {tool}                    an agent's tool call (or the MCP Tool node's span)
└─ tools/call {tool}          CLIENT   the request to the MCP server
   └─ tools/call {tool}       CLIENT   a later input round (2026-07-28), one per round

POST /mcp/:toolset            SERVER   the HTTP request to the gateway (linked, see below)
tools/call {tool}             SERVER   one per JSON-RPC request, batches included
└─ tools/call {upstream tool} CLIENT   the gateway's call to the server behind the tool
```

- **Client spans.** Every operation on an MCP server (`tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`) gets a CLIENT span named after the method, and after the tool or prompt for `tools/call` and `prompts/get`. The `initialize` handshake or the `server/discover` probe a first call needs happens inside that call's span. Built-in tools and workflow tools run inside L2M and get no MCP span. Calls answered from a recorded cassette get none either.
- **Input rounds.** When a 2026-07-28 server answers with `input_required`, each later round of the request is a child span with `l2m.mcp.round`, and the request's span gets `l2m.mcp.rounds`.
- **Gateway spans.** Every JSON-RPC request the gateway answers on `/mcp/:toolset` gets a SERVER span: `initialize`, `ping`, `tools/list` and `tools/call` from session-based clients, `server/discover`, `tools/list` and `tools/call` from 2026-07-28 clients. A batch gets one span per request.
- **Outcomes.** A JSON-RPC error sets `error.type` and `rpc.response.status_code` to its code; a tool result with `isError` sets `error.type=tool_error`; a failure in L2M's client sets its kind (`transport`, `timeout`, `outcome_unknown`, ...). Only the type is recorded, never the server's error text, arguments or results.

| Span | Attributes |
|---|---|
| CLIENT | `mcp.method.name`, `gen_ai.operation.name` (`execute_tool` for `tools/call`), `gen_ai.tool.name`, `gen_ai.prompt.name`, `mcp.resource.uri` (without credentials, query or fragment), `mcp.session.id` (session-based servers), `mcp.protocol.version`, `jsonrpc.request.id`, `network.transport` (`tcp` or `pipe` for stdio), `network.protocol.name`, `server.address` and `server.port` (host only), `l2m.mcp.server.id` (the registry id), `rpc.response.status_code`, `error.type` |
| SERVER (gateway) | the same names without `server.*`, plus `l2m.toolset.id` and `l2m.gateway.client.id` |

Metrics, exported with the other OTLP metrics: `mcp.client.operation.duration` and `mcp.server.operation.duration` (seconds), by method, protocol version, transport and outcome. The client histogram also carries the tool and prompt name; the gateway's does not, because callers choose those names. For the same reason a gateway request whose method MCP does not define is named `_OTHER`, and a JSON-RPC error code outside the range JSON-RPC reserves (-32768 to -32000) is recorded as `_OTHER` on the metrics (the span keeps the code).

### Trace context sent to MCP servers

Each request to an MCP server carries the active span's trace context in `params._meta` (`traceparent`, `tracestate`, and `baggage` when that propagator is on), for both protocol eras; over HTTP it is also sent as headers. The `initialize` request carries it in its headers only. It is merged with the request's other `_meta` keys (the progress token and the 2026-07-28 protocol keys), and trace context alone never makes a request look like a 2026-07-28 one. A server that rejects unknown request fields can be excluded: set `"propagateTraceContext": false` in its connection JSON (or untick **Send trace context** under **Protocol version** in its connection settings, for HTTP and stdio servers). `L2M_OTEL_PROPAGATE_TO_MCP=false` stops it for every server.

### Trace context the gateway receives

A gateway client can send trace context in `params._meta`, in the HTTP headers, or both. The `_meta` context wins: it becomes the parent of the request's SERVER span, and the HTTP request's span is linked (`l2m.link.reason=transport`). Every request that reaches the gateway carries a valid client token, so its context is continued under `L2M_OTEL_TRUST_INBOUND=authenticated` (the default) and `all`; with `none` the span stays in the HTTP request's trace and only links the caller's (`l2m.link.reason=untrusted_inbound`). The servers behind the gateway never receive a caller's `_meta` as it was sent: they get the context of the gateway's own CLIENT span, which keeps the caller's trace (and its `tracestate`) only when the caller's context was continued. Baggage in a caller's `_meta` is not carried on. In `_meta`, `traceparent` and `tracestate` longer than 512 characters and `baggage` longer than 8192 are ignored.

## Queues, clusters and approvals

The trace follows work that leaves the request, with no database change: the context is a few characters in JSON that is stored anyway.

```
POST /api/workflows/:id/enqueue         SERVER      (any instance)
└─ process l2m.queue                    CONSUMER    (the worker, on any instance)
   └─ invoke_workflow {workflow name}   the run, as above
```

- **Queued runs.** When a job is enqueued while a span is active (the request, the run that started an async child workflow, a dispatched run in `EXECUTION_DISPATCH=queue`), its payload carries that span's `traceparent` (and `tracestate`) as `traceContext`. The worker opens a `process l2m.queue` CONSUMER span under it and runs the job inside, so the run, its nodes and its tools are in the same trace, whichever instance claimed the job. With `L2M_OTEL_SPAN_DETAIL=verbose` a `send l2m.queue` PRODUCER span sits between them. The consumer span carries `messaging.system=l2m`, `messaging.destination.name` (the worker pool), `messaging.message.id` (the queue item id), `l2m.execution.id`, `l2m.queue.attempt` and `l2m.queue.wait_ms` (the time between the job being due and being claimed).
- **Retries and reaped jobs.** Each attempt is its own consumer span under the same parent, so a job that a lost worker's lease expired shows both attempts.  A job that throws (a missing workflow, a refused user) ends its span as an error with the error type.
- **Cluster hand-offs.** Run events relayed between instances (the result a dispatching instance waits for) carry no trace context: they are not work, and the spans on each side are already joined through the job.
- **Approvals.** When a run pauses for a decision, the state L2M stores holds the `traceparent` of the node that paused. The resumed run, hours or days later and on any instance, is a **new** `invoke_workflow` span whose parent is whatever started the resume (the approver's request, or the queue job it became) and which has a **span link** to the paused node. It is a link, not a parent, because the two runs are separate pieces of work. A resume with nothing stored (a pause from before tracing was on) has no link. MCP elicitations hold the run in place, so they stay inside the run's own spans.
- **Schedules and triggers** start a new trace for every fire, even though their timers were created inside a request.
- **Jobs from before.** A job without a context (tracing was off where it was enqueued, or an older instance enqueued it) starts a new trace. An older worker ignores the field.
- **Off means off.** While tracing is off nothing is added to a payload or to a paused run's state.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Combined OTLP/HTTP endpoint. Setting it turns tracing on. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Traces endpoint (full URL); overrides the combined one. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | Metrics endpoint (full URL); overrides the combined one. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Or `http/json`. Traces only. |
| `OTEL_EXPORTER_OTLP_HEADERS` | empty | `key=value` pairs, percent-decoded. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `10000` | Milliseconds per export. |
| `OTEL_SDK_DISABLED` | `false` | `true` turns every OpenTelemetry signal off, whatever else is set. |
| `OTEL_SERVICE_NAME` | `ai-orchestrator` | `service.name`. |
| `OTEL_SERVICE_VERSION` | unset | `service.version`. |
| `OTEL_RESOURCE_ATTRIBUTES` | empty | Extra resource attributes, percent-decoded. |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | See [Sampling](#sampling). |
| `OTEL_TRACES_SAMPLER_ARG` | unset | Ratio for the ratio samplers. |
| `OTEL_PROPAGATORS` | `tracecontext` | `tracecontext`, `baggage`, `none`. |
| `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` | `8192` | Longer attribute values are cut. |
| `OTEL_BSP_SCHEDULE_DELAY` | `5000` | Milliseconds between batch exports. |
| `OTEL_BSP_EXPORT_TIMEOUT` | `30000` | Milliseconds one batch export may take. |
| `OTEL_BSP_MAX_QUEUE_SIZE` | `2048` | Spans waiting for export; more are dropped. |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | `512` | Spans per export (at most the queue size). |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | empty | Comma list. `gen_ai_latest_experimental` switches the GenAI metrics to the conventions' newer, unreleased names. |
| `OTEL_HTTP_SERVER_SPANS` | `true` | One SERVER span per request while tracing is on. |
| `OTEL_METRICS_ENABLED` | `false` | Push metrics over OTLP. |
| `OTEL_METRICS_PUSH_INTERVAL_MS` | `60000` | Metrics push interval. |
| `L2M_OTEL_TRUST_INBOUND` | `authenticated` | See [Inbound trace context](#inbound-trace-context-and-who-is-trusted). |
| `L2M_OTEL_TRUSTED_PROXIES` | empty | Connections whose trace context is always continued. |
| `L2M_OTEL_SPAN_DETAIL` | `standard` | `verbose` adds one span per agent turn (`l2m.agent.iteration`). |
| `L2M_OTEL_NAMES` | `names` | `ids` keeps workflow, node and agent names out of spans. |
| `L2M_OTEL_PROPAGATE_TO_PROVIDERS` | `false` | Send `traceparent` (and `tracestate`) to model providers. |
| `L2M_OTEL_PROPAGATE_TO_MCP` | `true` | Send trace context to MCP servers (`_meta` and HTTP headers). A server can opt out in its connection settings. |

The standard `OTEL_*` values are read only while they are used, so values meant for other tools sharing the environment never stop L2M. While tracing is on, an unsupported value (a sampler, propagator, protocol or number L2M cannot use) falls back to its default with a warning at start-up. Only these stop the API at start-up, with a message naming the setting: an endpoint L2M is about to use that is not an absolute `http://` or `https://` URL, `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` with a traces endpoint set, and a bad `L2M_OTEL_*` value (such as a trusted-proxy entry that is not an IP address or CIDR range).

## Deprecated settings

These still work, and the API logs a warning at start-up when they are set:

- `TRACING_ENABLED` and `TRACING_ENDPOINT`: use `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`). If both are set, the `OTEL_*` endpoint wins. `TRACING_SERVICE_NAME` is still read when `OTEL_SERVICE_NAME` is unset.
- `OTEL_DEPLOYMENT_ENVIRONMENT`: it now sets `deployment.environment.name` (the stable attribute) rather than `deployment.environment`. Prefer `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<value>`.

## Verifying it works

`GET /api/observability` (admin) returns the settings in effect:

```json
{
  "metrics": { "executionsTotal": 12, "slo": { "healthy": true } },
  "tracing": {
    "enabled": true,
    "tracesEndpoint": "http://otel-collector:4318/v1/traces",
    "resourceAttributes": { "service.name": "ai-orchestrator", "telemetry.sdk.name": "opentelemetry" },
    "protocol": "http/protobuf",
    "exportHeaderNames": ["authorization"],
    "sampler": "parentbased_always_on",
    "httpServerSpans": true,
    "trustInbound": "authenticated",
    "spanDetail": "standard"
  },
  "otlpMetrics": {
    "enabled": true,
    "endpoint": "http://otel-collector:4318/v1/metrics",
    "intervalMs": 60000
  }
}
```

`GET /api/observability/traces` (admin) returns the most recent spans of the instance that answers, and `?traceId=<id>` the spans of one trace. In a cluster, each instance keeps its own.
