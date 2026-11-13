---
title: "OpenTelemetry for L2M: traces, GenAI and MCP spans"
description: "Send L2M traces and metrics to any OTLP backend: local collector quick start, every setting, the spans and metrics emitted, content capture, trust rules."
---

# OpenTelemetry

L2M can export OpenTelemetry traces and metrics over OTLP/HTTP to any OTLP-compatible backend, or to an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) that forwards them. A trace follows a request through the workflow run, its nodes, agent loops, model calls and MCP calls, across queue workers and approval resumes.

It is off by default. A deployment that sets none of the variables on this page loads no OpenTelemetry code, installs no hooks, adds nothing to requests or queue payloads, and runs exactly as before. Logs and the Prometheus `/metrics` page do not depend on it: see [Observability](./observability.md).

On this page:

- [Quick start with a local collector](#quick-start-with-a-local-collector)
- [When it is on](#when-it-is-on), [export](#export), [resource attributes](#resource-attributes) and [sampling](#sampling)
- What is traced: [HTTP](#http-server-spans), [runs](#run-spans), [models](#model-spans), [MCP](#mcp-spans-and-trace-context), [queues and approvals](#queues-clusters-and-approvals)
- [Metrics](#metrics-over-otlp), [content capture](#content-capture), [trace id on runs](#trace-id-on-runs)
- [Trace context and trust](#inbound-trace-context-and-who-is-trusted)
- [Settings](#settings), [performance](#performance), [troubleshooting](#troubleshooting), [upgrading](#upgrading-from-the-earlier-exporter)

## Quick start with a local collector

The repository ships a collector setup for trying this locally: [`ops/otel/docker-compose.yml`](https://github.com/TensorGreed/ai-orchestrator/blob/main/ops/otel/docker-compose.yml) and [`ops/otel/collector.yaml`](https://github.com/TensorGreed/ai-orchestrator/blob/main/ops/otel/collector.yaml). The collector listens for OTLP over HTTP on port 4318, prints a line per batch, and writes everything it receives to JSON-lines files.

1. Start the collector from the repository root. It runs as your user so it can write `ops/otel/otel-data/`:

   ```bash
   COLLECTOR_UID=$(id -u) COLLECTOR_GID=$(id -g) docker compose -f ops/otel/docker-compose.yml up -d
   ```

2. Start L2M with an endpoint (and, optionally, metrics):

   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
   OTEL_METRICS_ENABLED=true \
   OTEL_SERVICE_NAME=l2m-local \
   pnpm dev:product
   ```

   The API logs no warning when every setting is understood. An endpoint that is not an absolute `http://` or `https://` URL stops it at start-up with a message naming the variable.

3. Run any workflow, for example the zero-key **MCP Agent Quickstart** template (echo model, built-in mock MCP server).

4. Look at what arrived. Spans are exported in batches every 5 seconds, metrics every 60 seconds (`OTEL_METRICS_PUSH_INTERVAL_MS`), and both once more when the API stops cleanly:

   ```bash
   docker compose -f ops/otel/docker-compose.yml logs --tail 20
   tail -n 1 ops/otel/otel-data/traces.jsonl
   ```

   In L2M, **Settings → Observability** shows the settings in effect and the most recent spans of the instance.

The collector file is a starting point. For production, replace its `debug` and `file` exporters with your backends, and add the collector's own sampling, batching and retry settings.

A collector in another container or host works the same way: point `OTEL_EXPORTER_OTLP_ENDPOINT` at it, for example `http://otel-collector:4318` inside a compose network. To send traces and metrics to different places, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` instead. A per-signal endpoint is used as it is (include the `/v1/traces` or `/v1/metrics` path); it overrides the combined one, to which L2M adds those paths itself.

### Smoke test

`node scripts/otel-smoke.mjs` checks the whole path without any outside service. It starts a small OTLP receiver that writes what it gets to a file, starts the API on a temporary database pointing at it, runs the MCP agent quickstart with a `traceparent`, stops the API with `SIGTERM`, and checks that:

- one trace holds the HTTP request, the run, its nodes, the agent loop, the model call and the MCP `tools/list` call, under the caller's trace id, with the right parents from the request down to the model call;
- the run's stored trace id is that trace id;
- the OTLP auth header arrived decoded, and the resource carries the service name and `OTEL_RESOURCE_ATTRIBUTES`;
- the `ao.*` and GenAI metrics arrived;
- nothing was exported before the stop (so the exit flush delivered it), and no secret value (the master key, the OTLP token, the admin password) appears in what was sent.

`--protocol http/protobuf` runs it with the API's default encoding; that run checks the content type, the span and metric names and the trace id, while the parents, the header and the resource are checked in `http/json`. `--keep` keeps the work directory with the received file and the API log. The API test suite runs it in both encodings, except when `apps/api/.env` exists or `TEST_POSTGRES_URL` is set. It refuses to run when `apps/api/.env` sets a variable it needs, since that file overrides the environment.

## When it is on

| You set | Traces | OTLP metrics |
|---|---|---|
| Nothing | Off: no OpenTelemetry module is loaded | Off |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | On, exported to `<endpoint>/v1/traces` | With `OTEL_METRICS_ENABLED=true`, to `<endpoint>/v1/metrics` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | On, exported there | Off unless a metrics endpoint and `OTEL_METRICS_ENABLED=true` are also set |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_METRICS_ENABLED=true` | Off | On |
| `TRACING_ENDPOINT` (deprecated) | On, exported there | Off |
| `TRACING_ENABLED=true` (deprecated) and no endpoint | On, kept in memory only (for `GET /api/observability/traces`) | Off |
| `OTEL_SDK_DISABLED=true`, with anything else | Off | Off |

A metrics endpoint alone never turns tracing on: no spans, no HTTP hooks and no trace context are added. `GET /api/observability` (admin) reports what is in effect, see [Verifying it works](#verifying-it-works).

## Export

- **Protocol.** `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/protobuf` (the default, as in the OpenTelemetry specification) or `http/json`, for both traces and metrics. Collectors listening on port 4318 accept both. gRPC is not shipped: `grpc` with a traces or a metrics endpoint in use stops the API at start-up. Point L2M at the collector's HTTP port (4318), not its gRPC port (4317).
- **Batching.** Spans are exported in batches by the SDK's batch span processor, never one request per span. The `OTEL_BSP_*` variables tune it (see [Settings](#settings)). When the queue is full, new spans are dropped rather than slowing requests down.
- **Unreachable collector.** An export that fails or takes longer than `OTEL_EXPORTER_OTLP_TIMEOUT` (10 seconds by default) is dropped and counted in `l2m_otel_spans_dropped_total`. Exporting never blocks a request.
- **Shutdown.** On a clean stop, L2M flushes the spans still queued and the last metrics, waiting at most 5 seconds. Without a drain configured (`SHUTDOWN_DRAIN_MS` unset, not in cluster mode), `SIGTERM` and `SIGINT` also wait for that flush (at most 5 seconds) before the process exits, with the usual signal exit code. A process killed with `SIGKILL` loses what was queued.

### Auth headers

`OTEL_EXPORTER_OTLP_HEADERS` is a comma-separated `key=value` list added to every OTLP request, for a backend or collector that needs a token or a tenant id. Values are percent-decoded, as the specification asks, so encode a space as `%20` and a comma as `%2C`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20YOUR_TOKEN,x-tenant=l2m-prod
```

Header values are never shown by the API: `GET /api/observability` lists header names only. They are also removed from anything recorded on spans, including the bare credential after a `Bearer` or `Basic` scheme.

## Resource attributes

Every span and metric carries:

- `service.name`: `OTEL_SERVICE_NAME`, else `TRACING_SERVICE_NAME` (default `ai-orchestrator`). `OTEL_SERVICE_NAME` wins over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`, which in turn wins over `TRACING_SERVICE_NAME` and the default.
- `service.version`: `OTEL_SERVICE_VERSION`, if set.
- `telemetry.sdk.name`, `telemetry.sdk.language` and `telemetry.sdk.version`, set by the OpenTelemetry SDK.
- `host.name` (the machine's host name), `process.pid` and `service.instance.id` (a random id per start), so replicas can be told apart.
- Every `key=value` pair in `OTEL_RESOURCE_ATTRIBUTES` (percent-decoded); it overrides any of the above, and `service.name` too unless `OTEL_SERVICE_NAME` is set. Set `deployment.environment.name` here.

Spans are recorded under the instrumentation scope `l2m` with the schema URL `https://opentelemetry.io/schemas/1.41.0`; OTLP metrics under the scope `ai-orchestrator`.

## Sampling

`OTEL_TRACES_SAMPLER` takes the specification's built-in samplers: `always_on`, `always_off`, `traceidratio`, `parentbased_always_on` (the default), `parentbased_always_off` and `parentbased_traceidratio`. The two ratio samplers read `OTEL_TRACES_SAMPLER_ARG`, a number from 0 to 1; without it (or with a value outside that range) they sample every trace, as the specification says, and the API logs a warning. An unknown sampler falls back to the default with a warning.

To bound volume on a busy deployment, use `parentbased_traceidratio` with a small ratio, and keep tail sampling (for example "keep every trace with an error") in the collector. The parent-based samplers follow the sampled flag of a caller whose trace is continued (see [trust](#inbound-trace-context-and-who-is-trusted)), so a trusted caller that does not sample a request also turns off L2M's spans for it.

## What is traced

- **One SERVER span per HTTP request**, named `{method} {route}` (for example `POST /api/workflows/:id/execute`). `/health`, `/ready` and `/metrics` get no span. See [HTTP server spans](#http-server-spans).
- **Workflow runs, nodes, agents and tool calls**: one `invoke_workflow` span per run, one span per node that ran, `invoke_agent` per Agent or Supervisor loop and `execute_tool` per tool call the model made. See [run spans](#run-spans).
- **Model calls**: one `chat {model}` or `embeddings {model}` CLIENT span per call to a model provider, from a run, the `/v1` AI gateway or anywhere else, with token usage. See [model spans](#model-spans).
- **MCP calls and the MCP gateway**: a CLIENT span per request L2M sends to an MCP server, a SERVER span per request the gateway answers, and trace context sent on to MCP servers. See [MCP spans](#mcp-spans-and-trace-context).
- **Queue jobs and approval resumes**: a worker's job continues the trace of whoever enqueued it, on any instance, and a resume after an approval links back to the node that paused. See [queues, clusters and approvals](#queues-clusters-and-approvals).

A run started over HTTP looks like this:

```
POST /api/workflows/:id/execute            SERVER
└─ invoke_workflow {workflow name}         the run
   ├─ l2m.node {node type}                 one per node that ran
   └─ l2m.node agent_orchestrator
      ├─ tools/list                        CLIENT  the agent lists an MCP server's tools
      └─ invoke_agent {agent name}         the agent loop
         ├─ chat {model}                   CLIENT  each model call
         └─ execute_tool {tool name}       each tool call the model made
            └─ tools/call {tool}           CLIENT  the request to the MCP server
```

Span names and the GenAI and MCP attributes follow the OpenTelemetry semantic conventions pinned at **v1.41.0**. The GenAI and MCP conventions are still marked experimental (Development) upstream, so their names can change in a later release of the conventions; L2M keeps them in one place and says so in the changelog when it moves.

Spans carry ids and timings, not content: prompts, tool arguments and results stay in L2M's execution history, unless you turn on [content capture](#content-capture). Use `l2m.execution.id` to go from a trace to the run in L2M, and the run's [trace id](#trace-id-on-runs) to go the other way.

L2M creates these spans itself. Do not also run a GenAI auto-instrumentation agent for the same process: model calls would be recorded twice.

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

While tracing is on, every workflow run is traced below the request (or the trigger) that started it.

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

## Model spans

While tracing is on, every call L2M makes to a model provider gets a CLIENT span: `chat {model}` for a chat call and `embeddings {model}` for an embeddings call. The spans come from one place in front of the provider adapters, so every caller is covered once: LLM Call nodes, agent loops, the `/v1` AI gateway, content rule checks that call a model, evals and gateway sampling. The embedders of RAG nodes (`rag_retrieve`, Embeddings Azure OpenAI) and of knowledge bases (ingest, upload and search) go through the same place: each call gets an `embeddings` span with the token usage the provider reported (OpenAI, Azure OpenAI, Mistral and Cohere report it; Gemini and Hugging Face do not) and feeds the [GenAI metrics](#genai-and-cost-metrics), and a call the model allowlist refuses in a run is recorded with `error.type=model_not_allowed`. They still send their requests themselves, to the same endpoint with the same key, and the token embedder makes no model call. In a run, a call sits under its node's span, or under `invoke_agent` (or its turn, at verbose detail) for an agent loop.

```
POST /v1/chat/completions               SERVER  l2m.gateway.* attributes
└─ chat {model}                         CLIENT  one per model call
```

| Span | Attributes |
|---|---|
| `chat` | `gen_ai.operation.name`, `gen_ai.provider.name`, `l2m.provider.id`, `gen_ai.request.model`, `gen_ai.request.stream`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `server.address`, `server.port`, `l2m.retry.count`, `l2m.stream.closed_early` |
| `embeddings` | the same request and usage attributes, plus `gen_ai.embeddings.dimension.count` |

- **Providers.** `gen_ai.provider.name` uses the well-known values: `openai` (also for OpenAI-compatible servers, whose L2M id stays in `l2m.provider.id`), `azure.ai.openai`, `anthropic`, `gcp.gemini` and `ollama`. Other providers (such as the built-in `echo` model) use their L2M id. `server.address` is the provider's host, never its URL.
- **Streams.** A streamed answer's span stays open until the stream ends, and takes the usage and finish reason from its last chunks. When the reader stops early (the caller hung up, content rules cut the answer), the span ends then with `l2m.stream.closed_early`. Streamed calls carry no `gen_ai.response.model` or `gen_ai.response.id`.
- **Failures and refusals.** A failed call sets the span status to ERROR with its type as `error.type` (the L2M error category, such as `timeout` or `model_not_allowed`, else the error's class), never the provider's error text. A call the model allowlist refuses gets a span with `error.type=model_not_allowed`, though nothing was sent; it is left out of the metrics.
- **Recorded runs.** A model call answered from a recorded tape sends nothing and gets no span.
- **No content by default.** Prompts, answers, tool definitions and tool arguments are recorded on these spans only with [content capture](#content-capture) on, and then only masked.
- **`/v1` requests.** The gateway puts its ids and outcome on the request's HTTP span: `l2m.gateway.request.id` (the id of the request's usage row), `l2m.gateway.route_set.id`, `l2m.gateway.route.alias`, `l2m.gateway.client.id`, `l2m.gateway.status` (the usage row's status, or the refusal: `rate_limited`, `budget_blocked`, `model_not_allowed`) and `l2m.content_rules.outcome` (`blocked` or `rewritten`). A refused request has no `chat` span: no model was called.
- **Propagation.** L2M does not send `traceparent` to model providers by default: their endpoints are outside your trace domain. `L2M_OTEL_PROPAGATE_TO_PROVIDERS=true` adds it (and `tracestate`) to each provider request, for a provider or proxy you run yourself.

## MCP spans and trace context

While tracing is on, MCP traffic is traced in both directions, for servers on either protocol era (the `initialize` handshake or [2026-07-28](../product/mcp-2026-07-28.md)). Names and attributes follow the OpenTelemetry MCP semantic conventions pinned at v1.41.0, which are still marked experimental upstream.

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
- **Gateway spans.** Every JSON-RPC request the gateway answers on `/mcp/:toolset` gets a SERVER span: `initialize`, `ping`, `tools/list` and `tools/call` from session-based clients, `server/discover`, `tools/list`, `tools/call` and `subscriptions/listen` from 2026-07-28 clients. A batch gets one span per request. The span of a `subscriptions/listen` request ends when the stream is acknowledged (or refused), not when the stream closes. A listen request whose caller hung up before the stream opened gets `l2m.mcp.listen.outcome=caller_gone`, with no error.
- **Outcomes.** A JSON-RPC error sets `error.type` and `rpc.response.status_code` to its code; a tool result with `isError` sets `error.type=tool_error`; a failure in L2M's client sets its kind (`transport`, `timeout`, `outcome_unknown`, ...). Only the type is recorded, never the server's error text, arguments or results.

| Span | Attributes |
|---|---|
| CLIENT | `mcp.method.name`, `gen_ai.operation.name` (`execute_tool` for `tools/call`), `gen_ai.tool.name`, `gen_ai.prompt.name`, `mcp.resource.uri` (without credentials, query or fragment), `mcp.session.id` (session-based servers), `mcp.protocol.version`, `jsonrpc.request.id`, `network.transport` (`tcp`, or `pipe` for stdio), `network.protocol.name`, `server.address` and `server.port` (host only), `l2m.mcp.server.id` (the registry id), `rpc.response.status_code`, `error.type` |
| SERVER (gateway) | the same names without `server.*`, plus `l2m.toolset.id`, `l2m.gateway.client.id` and, for `subscriptions/listen`, `l2m.mcp.listen.outcome` |

Metrics, exported with the other OTLP metrics: `mcp.client.operation.duration` and `mcp.server.operation.duration` (seconds), by method, protocol version, transport and outcome. They are recorded while tracing is on, and also with only a metrics endpoint (`OTEL_METRICS_ENABLED=true` and a metrics endpoint, tracing off): then each MCP request is measured the same way, but no span is started and no trace context is sent to MCP servers. With neither on, nothing is loaded. The client histogram also carries the tool and prompt name; the gateway's does not, because callers choose those names. For the same reason a gateway request whose method MCP does not define is named `_OTHER`, and a JSON-RPC error code outside the range JSON-RPC reserves (-32768 to -32000) is recorded as `_OTHER` on the metrics (the span keeps the code).

### Trace context sent to MCP servers

Each request to an MCP server carries the active span's trace context in `params._meta` (`traceparent`, `tracestate`, and `baggage` when that propagator is on), for both protocol eras; over HTTP it is also sent as headers. Over HTTP the `initialize` request carries it in its headers only; over stdio it carries none. It is merged with the request's other `_meta` keys (the progress token and the 2026-07-28 protocol keys), and trace context alone never makes a request look like a 2026-07-28 one.

A server that rejects unknown request fields can be excluded: untick **Send trace context** under **Protocol version** in its connection settings (HTTP and stdio servers), or set `"propagateTraceContext": false` in its connection JSON. `L2M_OTEL_PROPAGATE_TO_MCP=false` stops it for every server.

### Trace context the gateway receives

A gateway client can send trace context in `params._meta`, in the HTTP headers, or both. The `_meta` context wins: it becomes the parent of the request's SERVER span, and the HTTP request's span is linked (`l2m.link.reason=transport`). Every request that reaches the gateway carries a valid client token, so its context is continued under `L2M_OTEL_TRUST_INBOUND=authenticated` (the default) and `all`; with `none` the span stays in the HTTP request's trace and only links the caller's (`l2m.link.reason=untrusted_inbound`).

The servers behind the gateway never receive a caller's `_meta` as it was sent: they get the context of the gateway's own CLIENT span, which keeps the caller's trace (and its `tracestate`) only when the caller's context was continued. Baggage in a caller's `_meta` is not carried on. In `_meta`, `traceparent` and `tracestate` longer than 512 characters and `baggage` longer than 8192 are ignored.

## Queues, clusters and approvals

The trace follows work that leaves the request, with no database change: the context is a few characters in JSON that is stored anyway.

```
POST /api/workflows/:id/enqueue         SERVER      (any instance)
└─ process l2m.queue                    CONSUMER    (the worker, on any instance)
   └─ invoke_workflow {workflow name}   the run, as above
```

- **Queued runs.** When a job is enqueued while a span is active (the request, the run that started an async child workflow, a dispatched run in `EXECUTION_DISPATCH=queue`), its payload carries that span's `traceparent` (and `tracestate`) as `traceContext`. The worker opens a `process l2m.queue` CONSUMER span under it and runs the job inside, so the run, its nodes and its tools are in the same trace, whichever instance claimed the job. With `L2M_OTEL_SPAN_DETAIL=verbose` a `send l2m.queue` PRODUCER span sits between them. The consumer span carries `messaging.system=l2m`, `messaging.destination.name` (the worker pool), `messaging.message.id` (the queue item id), `l2m.execution.id`, `l2m.queue.attempt` and `l2m.queue.wait_ms` (the time between the job being due and being claimed).
- **Retries and reaped jobs.** Each attempt is its own consumer span under the same parent, so a job that a lost worker's lease expired shows both attempts. A job that throws (a missing workflow, a refused user) ends its span as an error with the error type. An attempt the worker stops itself, because it is draining for shutdown or the job's lease was lost, is not an error: its span gets `l2m.queue.outcome=requeued` and no error status, and the job's next attempt (on this or another worker) is its own span.
- **Cluster hand-offs.** Run events relayed between instances (the result a dispatching instance waits for) carry no trace context: they are not work, and the spans on each side are already joined through the job.
- **Approvals.** When a run pauses for a decision, the state L2M stores holds the `traceparent` of the node that paused. The resumed run, hours or days later and on any instance, is a **new** `invoke_workflow` span whose parent is whatever started the resume (the approver's request, or the queue job it became) and which has a **span link** to the paused node. It is a link, not a parent, because the two runs are separate pieces of work. A resume with nothing stored (a pause from before tracing was on) has no link. MCP elicitations hold the run in place, so they stay inside the run's own spans.
- **Schedules and triggers** start a new trace for every fire, even though their timers were created inside a request.
- **Jobs from before.** A job without a context (tracing was off where it was enqueued, or an older instance enqueued it) starts a new trace. An older worker ignores the field.
- **Off means off.** While tracing is off nothing is added to a payload or to a paused run's state.

## Metrics over OTLP

With `OTEL_METRICS_ENABLED=true` and an endpoint (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, or `OTEL_EXPORTER_OTLP_ENDPOINT`, which also turns tracing on), L2M exports metrics through the OpenTelemetry SDK every `OTEL_METRICS_PUSH_INTERVAL_MS` (60 seconds by default), with the same protocol, headers and timeout as traces, and once more on a clean stop. Values are cumulative.

| Name | Kind |
|---|---|
| `ao.http.requests.total`, `ao.workflow.executions.total`, `ao.workflow.executions.success.total`, `ao.workflow.executions.failure.total` | Sum (monotonic, cumulative) |
| `ao.workflow.executions.active`, `ao.slo.success.rate`, `ao.slo.healthy`, `ao.uptime.seconds` | Gauge |
| `ao.workflow.execution.duration.p50.ms`, `.p95.ms`, `.p99.ms`, `ao.http.request.duration.p50.ms`, `.p95.ms` | Gauge, **deprecated**: use the histograms |
| `ao.workflow.execution.duration` (unit `s`, attribute `l2m.execution.status`) | Histogram |
| `ao.http.request.duration` (unit `s`, attributes `http.request.method`, `http.response.status_class`) | Histogram |
| `gen_ai.client.operation.duration` (s) and `gen_ai.client.token.usage` ({token}) | Histograms: the [GenAI metrics](#genai-and-cost-metrics) |
| `l2m.gen_ai.cost` (USD) | Sum: priced model spend |
| `mcp.client.operation.duration` and `mcp.server.operation.duration` (s) | Histograms: the [MCP metrics](#mcp-spans-and-trace-context), recorded while tracing is on or with only a metrics endpoint |
| `l2m_otel_spans_dropped_total` (attribute `reason=export_failed`) | Sum: spans lost to a failed export |
| `l2m_otel_content_dropped_total` (attribute `reason`) | Sum: spans exported without their captured content (see [content capture](#content-capture)) |

The `ao.*` values come from the same counters the Prometheus `/metrics` page reads (its names use `METRICS_PREFIX`, default `ao`, with underscores: `ao_http_requests_total`). With `METRICS_ENABLED=false` those counters stay at zero and the `ao.*` histograms get no observations. The percentile gauges are kept for one release and then removed; the histograms replace them. Spans lost when the queue is full, or still being exported when a shutdown times out, are not counted in `l2m_otel_spans_dropped_total`: only those lost to a failed export.

### GenAI and cost metrics

With metrics exported (tracing need not be on), every model call also feeds the GenAI client metrics, and priced spend feeds a counter:

| Name | Kind | Attributes |
|---|---|---|
| `gen_ai.client.operation.duration` | Histogram, s | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `server.address`, `server.port`, `error.type` on failures |
| `gen_ai.client.token.usage` | Histogram, {token} | the same, plus `gen_ai.token.type` (`input` or `output`); only counts the provider reported |
| `l2m.gen_ai.cost` | Sum, USD | `gen_ai.provider.name`, `gen_ai.request.model`, `l2m.project.id`, `l2m.usage.source` (`run` or `ai_gateway`) |

- **Cost is not priced twice.** `l2m.gen_ai.cost` is added where L2M already prices usage: when a run's usage event is written and when a `/v1` request's usage row is written, with the same pricing table. Those rows stay the record for spend, budgets and FinOps; the metric is an operational mirror that a collector may sample or drop. Unpriced models add nothing. A run of a workflow with no project is counted under `l2m.project.id=default`, as the model allowlists count it; a `/v1` request carries its route set's project when the route set has one.
- **No per-run ids on metrics.** Execution, workflow, node, session and client ids are on spans only, to keep the number of series bounded.
- **Newer names.** The GenAI conventions are still experimental, and their newer, unreleased text renames these metrics. `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` switches to those names: chat calls report `gen_ai.client.inference.duration`, the counters `gen_ai.client.inference.usage.input_tokens`, `.output_tokens` and `.cache_read.input_tokens` (with `gen_ai.token.modality=unknown`, since providers report totals) and the histograms `gen_ai.client.inference.operation.input_tokens` and `.output_tokens`; embeddings calls report `gen_ai.client.embeddings.duration` and `gen_ai.client.embeddings.operation.input_tokens`. These names may change again before that text is released. The cost counter is the same in both modes.

## Content capture

Off by default. With `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` set (and tracing on), model and tool spans also carry the content of the call, after it was cleaned. It is for debugging and evaluating agents in a tracing backend you control; L2M's execution history stays the full record either way.

| Value | What is recorded |
|---|---|
| `NO_CONTENT` (default) | Nothing. Any value L2M does not know means this too, with a start-up warning. |
| `SPAN_ONLY` | Content attributes on the spans. |
| `EVENT_ONLY` | A `gen_ai.client.inference.operation.details` span event on each `chat` span holding the model call's content. Tool spans get no content: the conventions define this event for model calls only. |
| `SPAN_AND_EVENT` | Both. |

The value is not case-sensitive. The older `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is read when the new variable is unset (`true` means `SPAN_ONLY`, `false` means `NO_CONTENT`). Capture needs `SECRET_MASTER_KEY_BASE64`; without it nothing is captured and start-up says so.

**What is captured.** The GenAI conventions' opt-in content attributes, pinned at v1.41.0 and recorded as JSON text:

| Span | Attributes |
|---|---|
| `chat {model}` | `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` (the answer as it was read, for a stream too), `gen_ai.tool.definitions` |
| `execute_tool {tool}` | `gen_ai.tool.call.arguments` (as sent, after content rules and tool policy), `gen_ai.tool.call.result` (as the model sees it) |
| `tools/call {tool}` (MCP CLIENT) | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, for an MCP Tool node's call. An agent's call is recorded once, on its `execute_tool` span, as the agent kept it after its labels and content rules. |

**Where.** Content is captured for workflow runs (their LLM Call nodes, agent loops and MCP Tool nodes, sub-workflows included). `/v1` AI gateway requests capture it only when `L2M_OTEL_CAPTURE_GATEWAY_CONTENT=true` is set as well: their prompts come from outside applications and the gateway has no sensitive marking of its own, so masking is all that protects them. Everything else records none, even with capture on: MCP gateway proxying (`subscriptions/listen` streams included), a tool tried from the server registry, eval and replay judges, MCP sampling, and provider connection tests.

Images are named by type only, never copied. Not captured: embedding inputs, retrieval queries, memory records (memory a model call sends is part of its input messages), error text from a provider or tool, and anything on run, node, agent or MCP gateway SERVER spans. A model call's content is recorded as it went to and came from the provider, including an answer that content rules then blocked or rewrote (cleaned as below). Earlier tool errors and content rule notices the model is shown are part of the next call's input messages.

**How content is cleaned.** Nothing is set on a span as it was handed over. When the span ends it is held back from the exporter (and from **Settings → Observability**'s recent spans) while L2M, off the request path:

1. removes secrets: credential fields and token shapes, and every secret value the deployment holds, as it is and URL- or base64-encoded (stored secrets, cached external secrets, values stored or read since start-up, credential environment variables, passwords in URL-valued environment variables and the OTLP header values). Values shorter than 6 characters are not matched, and a secret created on another instance is matched here within 30 seconds;
2. masks what [content rules](../product/content-rules-engine.md) detect, with stable keyed surrogates: the built-in data classes (emails, phone numbers, card numbers, national ids, ...) and the dictionaries of every rule set. The same value gets the same surrogate on every span, so a backend can still group by it; the key is derived from the master key and differs from production capture's;
3. cuts each attribute to `L2M_OTEL_CONTENT_MAX_CHARS` characters (default 8192, and never more than `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`), keeping valid JSON (long strings first, then the end of long lists, marked `…[truncated]`). Cutting happens after masking, so a cut never leaves part of a value unmasked;
4. checks the result once more for secret values.

**When content is left out.** The span is still exported, without any content, and `l2m.content.dropped` says why:

| `l2m.content.dropped` | Why |
|---|---|
| `sensitive` | The work is sensitive: the run, or a sub-workflow it calls, has a node marked **Sensitive output** or uses a secret flagged so, or a registered MCP server it uses could not be checked when the run started (the whole run); a Reveal node revealed something (the rest of the run); or, on runs that track data labels, the node's input or what an agent loop has seen so far is labelled sensitive (which includes any detected data class). It is checked when content is handed over and again when the span ends. |
| `sensitive_memory` | The run read session state written by sensitive work (the rest of the run): agent memory or a Simple Memory node, a tool cache record (`session_cache_list` / `session_cache_get`) or a Session Artifact Load node, from a row marked sensitive or stored with labels that say sensitive. See [Session state from sensitive runs](#session-state-from-sensitive-runs). |
| `sensitive_run_data` | The run started from content of a run that was sensitive work (the whole run): an error workflow run for such a run's failure, pinned data copied from such a run, or a retry, a run from a source execution or a single-node run with node outputs copied from one. See [Content copied from sensitive runs](#content-copied-from-sensitive-runs). |
| `sensitive_knowledge` | The run retrieved a knowledge base chunk that sensitive work added (the rest of the run). See [Content copied from sensitive runs](#content-copied-from-sensitive-runs). |
| `masking_failed`, `masking_incomplete`, `unscannable` | Masking failed, could not replace a value everywhere, or the content is nested too deep to scan. |
| `secret_detected` | The final check still found a secret value. |
| `timeout` | Masking, or reading the secret values and dictionaries it needs, took more than 10 seconds. |
| `backpressure` | More than 256 spans were waiting for masking. |
| `too_large` | The span's content is over 8 times the attribute limit (the smaller of `L2M_OTEL_CONTENT_MAX_CHARS` and `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`) of text, at least 64 KiB and at most 1 MiB. |

`l2m_otel_content_dropped_total` (by `reason`) counts these in the OTLP metrics.

**Visibility.** Start-up logs a warning and writes a `telemetry.content_capture_enabled` audit event while capture is on (both say whether `/v1` requests are included, as `gatewayContent`), and `GET /api/observability` reports `contentCapture`, `contentMaxChars` and `gatewayContentCapture`. Content capture is never on for a deployment that does not set the variable, and it changes nothing while tracing is off.

**Before you turn it on.** Captured content leaves the deployment for your tracing backend. Masking replaces what content rules detect and the secret values L2M knows, not every personal detail a prompt can hold. Restrict who can read traces in the backend, and keep its retention as short as you keep run history.

### Session state from sensitive runs

Session memory, the session tool cache and session artifacts outlive a run, and a later run can send them to a model. So a row written by sensitive work (as in the `sensitive` row above, or by a run that itself read such a row; with capture off, see below for which reads count) is marked `sensitive` (migration v73, SQLite and Postgres, `INTEGER NOT NULL DEFAULT 0` on `session_memory`, `session_tool_cache` and `session_artifacts`). Marks are written whether or not capture is on, so turning capture on later does not export what sensitive runs stored before. A run that reads a marked row (or a row from before v73 whose stored labels say sensitive) exports no content from then on (`sensitive_memory`) and marks what it writes in turn; a run paused for an approval keeps this when it resumes. A mark stays until the row is deleted: retention, erasure and legal holds treat marked rows like any other, `db:export` / `db:import` and `db:copy` keep the column (the tool cache is not exported), and a replay's memory seed keeps the mark. Memory works as before either way.

While capture is on, a read of a marked row also puts `sensitive` on the reading node's data labels and on the run's output labels, as a node marked **Sensitive output** does, so a caller that runs the workflow as a tool (a Workflow Tool, Execute Workflow, the MCP gateway) treats its answer as sensitive too. With capture off, nothing is exported and reads change nothing you can see: a marked row adds no label, so labels and tool rules behave exactly as they would without the mark. Rows written by sensitive work are still marked then, and a run that reads a marked row (memory, a tool cache record or a session artifact) still marks what it writes, so the mark follows the data whether or not capture is on. Every row carries its mark in the row itself: a memory read loads the messages and the mark in the same query (since v74), so marks cost no extra query per read. What it costs: with capture on or off, on a run's first session write, the same check of its nodes, sub-workflows and registered MCP servers that capture makes at run start (a server or sub-workflow that cannot be checked counts as sensitive). Limits: rows written before v73 carry no mark (only their stored labels count, so memory written by a sensitive run that tracked no labels before the upgrade is not covered), nor do rows restored from a pre-v73 backup or replayed from a pre-v73 memory seed; rolling the schema back below v73 drops the marks. A mark is never cleared while the row exists, even after the sensitive turns leave the memory window, so a long-lived session that once held sensitive data exports no content for good; delete the session's memory to start over.

### Content copied from sensitive runs

Content of a sensitive run can also reach a later run outside session state. Migration v74 (SQLite and Postgres, `INTEGER NOT NULL DEFAULT 0` on `execution_history` and `knowledge_base_chunks`) marks the run records and knowledge base chunks of sensitive work, whether or not capture is on; rows from before v74 stay unmarked (nothing is backfilled). A later run that uses such content exports no content and marks what it writes, as after a read of marked session state:

- **Error workflows.** The error workflow of a failed run that was sensitive work (as for a session write: a declared sensitive source, a Reveal, sensitive labels on the failed node, or a read of marked content) exports no content (`sensitive_run_data`). The failing run is checked only when it has an error workflow.
- **Pinned data.** Pinning a node's output from a run (the editor sends the run's id with `PUT /api/workflows/:id/pins/:nodeId`) marks the pin when that run was marked, was never finished by its executor (a cancel or a restart ended it), cannot be read, or the workflow it ran (the published version of a production run, and the draft) declares a sensitive source; the mark is stored with the workflow (`pinnedDataSensitive`) and stays while the node is pinned, even when the data is edited or replaced, so a save from a client that does not know the field cannot clear it. Remove the pin to clear it. A run that uses a marked pin exports no content (`sensitive_run_data`). Data pinned by hand, without a run, is your own input and is not marked.
- **Retries and node outputs.** A retry or a run from a source execution (`sourceExecutionId`), and a single-node run whose node outputs came from a run (`nodeOutputsExecutionId`), export no content (`sensitive_run_data`) on the same terms. With a queue, such runs (and runs that use marked pins) go only to workers that understand the mark, inline otherwise, and they are not recorded for replay.
- **Knowledge bases.** Chunks a sensitive run adds through a Retrieve node are marked; a run that retrieves a marked chunk (only the chunks a search returns count) exports no content from then on (`sensitive_knowledge`). Chunks added through the knowledge base API are not marked.

While capture is on, the pinned or retrieved content also carries the `sensitive` label, so an agent that receives it reports `sensitive` as its drop reason (its own check of what it has seen comes first). A run record's mark is not part of the run the API returns, stays through later writes of the record, and goes with the row (retention, erasure, `db:export` / `db:import` and `db:copy` keep the column). Rolling the schema back below v74 drops these marks.

## Trace id on runs

While tracing is on, a run's history row stores the trace id of its run span (migration v72, SQLite and Postgres, nullable column). `GET /api/executions/:id` returns it as `traceId`; a run made while tracing was off has `traceId: null`, and nothing is stored or written for it. The run page shows **Copy trace id** for a run that has one.

With `L2M_OTEL_TRACE_URL_TEMPLATE` set (an absolute `http(s)` URL containing `{traceId}`, for example `https://traces.example.com/trace/{traceId}`), the response also carries `traceUrl` and the run page shows an **Open trace** link. A run resumed after an approval is traced as a new run, so the stored id is the latest one. The column is removed with the run by retention and erasure, and the trace in your backend follows that backend's own retention.

Log lines written during a run carry the same id as `trace_id` (see [Trace ids in logs](./observability.md#trace-ids-in-logs)), so you can go from a run to its log lines and its trace.

## Inbound trace context and who is trusted

A caller can send a W3C `traceparent` header (and `tracestate`). Whether L2M continues that trace depends on who the caller is, set by `L2M_OTEL_TRUST_INBOUND`:

| Value | Behaviour |
|---|---|
| `authenticated` (default) | The trace continues (and its sampled flag is honoured) when the request carries a valid credential: a live signed-in session, an unexpired API key (whatever its scopes), or an MCP / AI gateway client token. It also continues for connections from `L2M_OTEL_TRUSTED_PROXIES`. Anyone else's request starts a new trace with a **link** to theirs. |
| `all` | Every caller's trace continues. Use only when the API is reachable solely through your own services. |
| `none` | No caller's trace continues; every request starts a new trace that links to the caller's. |

This stops an anonymous caller (a public webhook, for example) from switching sampling on or off for your traces, or from making your spans part of their trace. The credential check only reads the credential: it records no key or token use, does not count as session activity and ends no session, and the route still authenticates (and authorizes) the request as usual. Holding any valid credential is enough to continue a trace, even one that the route then refuses for lack of permission.

`L2M_OTEL_TRUSTED_PROXIES` is a comma list of IP addresses or CIDR ranges. It is matched against the address that opened the connection (not `X-Forwarded-For`), so list the proxy or gateway in front of L2M that passes on your own services' trace context. Every request arriving through a listed address is trusted, so do not list an internet-facing load balancer or ingress: that trusts every caller on the internet, as `all` does. An entry that is not an IP address or CIDR range stops the API at start-up.

`OTEL_PROPAGATORS` chooses the formats read from callers and sent to MCP servers: `tracecontext` (default), `baggage`, or `none` to ignore inbound context entirely. An unsupported entry is ignored with a warning. Baggage is never copied into span attributes.

Outbound, L2M sends trace context to MCP servers ([above](#trace-context-sent-to-mcp-servers)), to the workers that run queued jobs, and to model providers only with `L2M_OTEL_PROPAGATE_TO_PROVIDERS=true`. HTTP Request nodes and other outbound calls of a workflow do not send it.

## Settings

Every setting is optional. Unset means the default shown, and an empty value counts as unset.

| Variable | Default | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Combined OTLP/HTTP endpoint. Setting it turns tracing on; traces go to `/v1/traces`, metrics (with `OTEL_METRICS_ENABLED`) to `/v1/metrics`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Traces endpoint (full URL); overrides the combined one. Setting it turns tracing on. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | Metrics endpoint (full URL); overrides the combined one. Does not turn tracing on. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Or `http/json`, for traces and metrics. `grpc` is not shipped. |
| `OTEL_EXPORTER_OTLP_HEADERS` | empty | `key=value` pairs added to every export, percent-decoded. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `10000` | Milliseconds per export. |
| `OTEL_SDK_DISABLED` | `false` | `true` turns every OpenTelemetry signal off, whatever else is set. |
| `OTEL_SERVICE_NAME` | `ai-orchestrator` | `service.name` (falls back to `TRACING_SERVICE_NAME`). |
| `OTEL_SERVICE_VERSION` | unset | `service.version`. |
| `OTEL_RESOURCE_ATTRIBUTES` | empty | Extra resource attributes, `key=value` pairs, percent-decoded. |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | See [Sampling](#sampling). |
| `OTEL_TRACES_SAMPLER_ARG` | unset (ratio 1) | Ratio from 0 to 1 for the ratio samplers. |
| `OTEL_PROPAGATORS` | `tracecontext` | Comma list of `tracecontext`, `baggage`, `none`. |
| `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` | `8192` | Longer attribute values are cut. |
| `OTEL_BSP_SCHEDULE_DELAY` | `5000` | Milliseconds between batch exports. |
| `OTEL_BSP_EXPORT_TIMEOUT` | `30000` | Milliseconds one batch export may take. |
| `OTEL_BSP_MAX_QUEUE_SIZE` | `2048` | Spans waiting for export; more are dropped. |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | `512` | Spans per export (at most the queue size). |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | empty | Comma list. `gen_ai_latest_experimental` switches the GenAI metrics to the conventions' newer, unreleased names. |
| `OTEL_HTTP_SERVER_SPANS` | `true` | One SERVER span per request while tracing is on. |
| `OTEL_METRICS_ENABLED` | `false` | Push metrics over OTLP (needs a metrics endpoint or the combined one). |
| `OTEL_METRICS_PUSH_INTERVAL_MS` | `60000` | Metrics push interval. |
| `L2M_OTEL_TRUST_INBOUND` | `authenticated` | `authenticated`, `all` or `none`. See [trust](#inbound-trace-context-and-who-is-trusted). |
| `L2M_OTEL_TRUSTED_PROXIES` | empty | IP addresses or CIDR ranges whose inbound trace context is continued under `authenticated` (ignored with `none`). |
| `L2M_OTEL_SPAN_DETAIL` | `standard` | `verbose` adds one span per agent turn (`l2m.agent.iteration`) and a `send l2m.queue` PRODUCER span per enqueued job. |
| `L2M_OTEL_NAMES` | `names` | `ids` keeps workflow, node and agent names out of spans. |
| `L2M_OTEL_TRACE_URL_TEMPLATE` | unset | An absolute http(s) URL containing `{traceId}`. The run page then links each traced run to it (**Open trace**). |
| `L2M_OTEL_PROPAGATE_TO_PROVIDERS` | `false` | Send `traceparent` (and `tracestate`) to model providers. |
| `L2M_OTEL_PROPAGATE_TO_MCP` | `true` | Send trace context to MCP servers (`_meta` and HTTP headers). A server can opt out in its connection settings. |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` | `NO_CONTENT` | `SPAN_ONLY`, `EVENT_ONLY` or `SPAN_AND_EVENT` record masked content. See [Content capture](#content-capture). |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | unset | Older name for the same switch (`true` = `SPAN_ONLY`), read only when the variable above is unset. |
| `L2M_OTEL_CONTENT_MAX_CHARS` | `8192` | Longest captured content attribute (256 to 1048576). |
| `L2M_OTEL_CAPTURE_GATEWAY_CONTENT` | `false` | `true` also captures content for `/v1` AI gateway requests, while content capture is on. Workflow runs do not depend on it. |

Most standard `OTEL_*` values are read only while they are used, so values meant for other tools sharing the environment do not stop L2M. `OTEL_METRICS_ENABLED`, `OTEL_HTTP_SERVER_SPANS` and `TRACING_ENABLED` take `true`, `false`, `1`, `0`, `yes` or `no`, and `OTEL_METRICS_PUSH_INTERVAL_MS` a positive whole number; another value stops the API at start-up only when it would take effect: `TRACING_ENABLED` unless `OTEL_SDK_DISABLED=true`, `OTEL_HTTP_SERVER_SPANS` while tracing is on, `OTEL_METRICS_ENABLED` with a metrics endpoint set (`OTEL_EXPORTER_OTLP_ENDPOINT` counts), and the interval while metrics are exported. While tracing or metrics export is on, an unsupported value (a sampler, propagator, protocol or number L2M cannot use) falls back to its default with a warning at start-up. Besides those, only these stop the API at start-up, with a message naming the setting: an endpoint L2M is about to use that is not an absolute `http://` or `https://` URL, `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` with a traces or metrics endpoint in use, and a bad `L2M_OTEL_*` value (such as a trusted-proxy entry that is not an IP address or CIDR range, or a trace URL template without `{traceId}`).

All of these are listed, commented, in [`.env.example`](https://github.com/TensorGreed/ai-orchestrator/blob/main/.env.example).

### Deprecated settings

These still work, and the API logs a warning at start-up when they are set:

| Variable | Default | Use instead |
|---|---|---|
| `TRACING_ENABLED` | `false` | `OTEL_EXPORTER_OTLP_ENDPOINT`. With no endpoint, `true` keeps spans in memory only. |
| `TRACING_ENDPOINT` | unset | `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (a full traces URL). If both are set, the `OTEL_*` endpoint wins. |
| `TRACING_SERVICE_NAME` | `ai-orchestrator` | `OTEL_SERVICE_NAME`. Still read when `OTEL_SERVICE_NAME` is unset (no warning). |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | unset | `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<value>`. It now sets `deployment.environment.name` (the stable attribute) rather than `deployment.environment`. |

## Verifying it works

`GET /api/observability` (admin) returns the settings in effect; **Settings → Observability** shows the same:

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

`GET /api/observability/traces` (admin) returns the most recent spans of the instance that answers (50 by default, `?limit=` up to 200, from the last 5,000 it keeps), and `?traceId=<id>` the spans of one trace. In a cluster, each instance keeps its own.

## Performance

- **Off.** No OpenTelemetry module is loaded (a test starts the API in a fresh process and checks the list of loaded modules), no HTTP hooks are installed, and the provider and MCP registries are not wrapped. What remains on each node, model call or tool call is a check that tracing is off.
- **On.** Spans are created in the process and exported by a background timer in batches (every 5 seconds, 512 per request). The export never blocks a request. When the export queue (2048 spans) is full, new spans are dropped instead of using more memory. Each instance also keeps its last 5,000 spans in memory for **Settings → Observability**.
- **Volume.** A run produces one span per node that ran, plus one per agent loop, model call, tool call and MCP request. Keep `L2M_OTEL_SPAN_DETAIL=standard` (verbose adds a span per agent turn and per enqueued job), sample with `parentbased_traceidratio` on busy deployments, and set `OTEL_HTTP_SERVER_SPANS=false` if you only want run spans. Metrics carry no per-run ids, so their number of series stays bounded.
- **Content capture.** Masking runs after the span's timing is fixed and off the request path, so it delays export, not the request. It is bounded: more than 256 spans waiting, or 10 seconds per span, drops the content instead (see [content capture](#content-capture)). Very large prompts make masking slower; `L2M_OTEL_CONTENT_MAX_CHARS` and the `too_large` limit keep it bounded.
- **Shutdown.** A clean stop waits at most 5 seconds for the last export.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives at the collector | `GET /api/observability`: is `tracing.enabled` true and `tracesEndpoint` what you expect? `OTEL_SDK_DISABLED=true` turns everything off. Spans leave in batches every 5 seconds, so wait a moment, or stop the API cleanly to flush. A process killed with `SIGKILL` loses what was queued. |
| The API logs export errors, or the collector answers 404 or 415 | Use the collector's OTLP/HTTP port (4318), not gRPC (4317). A per-signal endpoint needs its full path (`.../v1/traces`); the combined endpoint must not have it. Check the collector accepts the protocol you set. |
| `401` or `403` from the backend | `OTEL_EXPORTER_OTLP_HEADERS` values are percent-decoded: write `authorization=Bearer%20<token>`, not a raw space. `GET /api/observability` lists the header names it will send. |
| Start-up fails naming an `OTEL_*` or `L2M_OTEL_*` variable | An endpoint that is not an absolute http(s) URL, `grpc`, or a bad `L2M_OTEL_*` value. See [Settings](#settings). |
| A start-up warning says a value is not supported | That variable fell back to its default. The warning names the value it ignored. |
| A caller's trace and L2M's are separate | L2M continued the caller's `traceparent` only if the caller was [trusted](#inbound-trace-context-and-who-is-trusted). An anonymous caller (a public webhook) gets a new trace with a link to theirs. Add your proxy to `L2M_OTEL_TRUSTED_PROXIES` if it passes on your own services' context. |
| Some requests have no spans at all | A trusted caller sent `traceparent` with the sampled flag `00`, and the default parent-based sampler followed it. Or a ratio sampler dropped the trace. |
| No spans for an MCP server's calls, or the server rejects requests | A server that refuses unknown `_meta` keys: untick **Send trace context** for it. Calls answered from a cassette, and built-in or workflow tools, get no MCP span. |
| No metrics | `OTEL_METRICS_ENABLED=true` and a metrics endpoint are both needed. The first push comes after `OTEL_METRICS_PUSH_INTERVAL_MS` (60 s). |
| Content capture is on but spans have no content | Look at `l2m.content.dropped` on the span. Also check that tracing is on, that the variable is spelled right (an unknown value means `NO_CONTENT`, with a warning), that `SECRET_MASTER_KEY_BASE64` is set, and, for `/v1`, `L2M_OTEL_CAPTURE_GATEWAY_CONTENT=true`. |
| Model calls appear twice | Another GenAI auto-instrumentation is running in the same process. L2M records its own; turn the other one off. |
| The collector container exits with "permission denied" | It cannot write `ops/otel/otel-data/`. Start it with `COLLECTOR_UID=$(id -u) COLLECTOR_GID=$(id -g)`, as in the [quick start](#quick-start-with-a-local-collector). |

`node scripts/otel-smoke.mjs` ([above](#smoke-test)) checks a checkout end to end without a collector.

## Upgrading from the earlier exporter

Releases before the OpenTelemetry SDK sent spans with a hand-built exporter. A deployment that set none of the variables sees no change. One that already exported traces should know:

- The default encoding is now `http/protobuf`. `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` keeps the old one.
- HTTP spans use the stable attribute names: `http.request.method`, `http.response.status_code`, `url.path`, `http.route`, `client.address` instead of `http.method`, `http.status_code`, `http.target`, `net.peer.ip`. Update queries and dashboards that use the old names.
- A caller's `traceparent` is continued only for [trusted callers](#inbound-trace-context-and-who-is-trusted). `L2M_OTEL_TRUST_INBOUND=all` restores the old behaviour.
- `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES` values are percent-decoded.
- `OTEL_DEPLOYMENT_ENVIRONMENT` sets `deployment.environment.name`; `TRACING_*` and `OTEL_DEPLOYMENT_ENVIRONMENT` are deprecated.
- The OTLP metric names are unchanged; the percentile gauges are deprecated in favour of the duration histograms.

The [changelog](https://github.com/TensorGreed/ai-orchestrator/blob/main/CHANGELOG.md) lists each change.

## Related

- [Observability](./observability.md): logs, the Prometheus `/metrics` page and SLO numbers
- [MCP 2026-07-28 support](../product/mcp-2026-07-28.md): the MCP protocol eras the MCP spans cover
- [MCP tool-call telemetry](../product/mcp-tool-call-telemetry.md): per-call records kept in L2M
- [Queue and workers](./queue-and-workers.md), [Cluster operations](./cluster.md)
- Concepts: [OpenTelemetry](../glossary/index.md#opentelemetry) (glossary)
