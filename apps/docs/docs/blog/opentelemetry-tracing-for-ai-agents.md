---
title: "Tracing AI agents with OpenTelemetry, end to end"
description: "One trace from the HTTP request through the agent loop, model calls and MCP servers, across queues and approvals, using the GenAI semantic conventions."
date: 2026-11-16
author: "The L2M team"
related: [agent-loop, tool-calling, mcp-server, masking, human-in-the-loop]
socialCard: true
---

# Tracing AI agents with OpenTelemetry, end to end

When an agent run is slow, expensive or wrong, the first question is where the time, the tokens and the decision went. Between 12 and 13 November 2026 we merged OpenTelemetry tracing and metrics for L2M: one trace that follows a request through the workflow run, its nodes, the <Term id="agent-loop">agent loop</Term>, each model call and each call to an <Term id="mcp-server">MCP server</Term>, including work that continues on another instance or days later after an approval. This post covers the decisions behind it, most of which apply to any system that traces agents.

All of it is off by default. A deployment that sets no OpenTelemetry variable loads no OpenTelemetry code at all.

## The shape of an agent trace

Here is a run started over HTTP, with an agent that lists an MCP server's tools and calls one:

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

The names are not ours. `invoke_workflow`, `invoke_agent`, `chat {model}` and `execute_tool` come from the OpenTelemetry GenAI semantic conventions, and `tools/call {tool}` from the MCP conventions. Using them means a backend that understands the conventions can show token usage, model names and tool calls without being taught L2M's vocabulary.

There is a catch: the GenAI and MCP conventions are marked "Development" upstream, so names can still change. We pinned them at v1.41.0 and keep them in one place. For the metrics, whose names the newer, unreleased text already changes, `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` switches to the new names. Pinning and an explicit opt-in are the usual answer to an experimental standard: you get the shared vocabulary now, and a changelog line when it moves.

## Decision 1: steps get spans, attachments do not

An L2M agent node has attachment ports: the chat model, memory, MCP tools and, for a Supervisor, workers. They are not steps of the workflow; the agent runtime uses them while the agent node runs. We gave them no `l2m.node` span of their own. Their work appears inside the agent's spans instead: each model call as `chat`, each tool call as `execute_tool`, each worker as a nested `invoke_agent` under the call that delegated to it.

The rule generalises: trace the work, not the configuration. A span per attached node would show four empty bars and hide where the time actually went.

## Decision 2: outcomes are not errors

A trace backend counts error spans, alerts on them and colours them red. Treating every unusual outcome as an error makes that signal useless. So `l2m.run.status` and `l2m.node.status` hold the outcome (`success`, `error`, `canceled`, `waiting_approval`), and only a run or node that failed sets the span status to ERROR (a node or tool call still in flight when a run is canceled or times out can show as ERROR too).

A canceled run is not an error. Neither is a pause for a person's approval. A tool call that a [tool policy](/product/mcp-tool-policy) or a content rule blocked is an outcome too (`l2m.tool.outcome=blocked`): the control did its job. A queue job a draining worker hands back gets `l2m.queue.outcome=requeued`, not an error, because its next attempt is its own span.

## Decision 3: ids and timings, not content

By default, spans carry ids, names, timings and token counts. Prompts, tool arguments and results stay in L2M's execution history. The GenAI conventions agree: `gen_ai.input.messages` and `gen_ai.output.messages` are opt-in, and the conventions warn that they are "likely to contain sensitive information including user/PII data". Error text is left off for the same reason: a failed call records its error type (`timeout`, `model_not_allowed`, `tool_error`), never the provider's or the tool's message, which often echoes the input.

To move between the two worlds, every run span has `l2m.execution.id`, and every run traced while tracing is on stores the trace id of its span (`traceId` on the run, with a **Copy trace id** button and an optional **Open trace** link built from `L2M_OTEL_TRACE_URL_TEMPLATE`).

## Decision 4: model spans in one place

Model calls happen all over a platform like this: LLM Call nodes, agent loops, the `/v1` AI gateway, evals, content rule checks that ask a model, MCP sampling, RAG embedders. Instrumenting each caller is how calls get missed or counted twice. The `chat` and `embeddings` spans come from one place in front of the provider adapters, so every caller is covered once.

That also answers the cost question. `l2m.gen_ai.cost` is added where L2M already prices usage, with the same pricing table, so the metric mirrors the spend records and never prices a call a second time. The records stay the source of truth for [budgets](/product/budgets); the metric is an operational view that a collector may sample or drop. (It also means you should not run a GenAI auto-instrumentation agent on the same process: model calls would be recorded twice.)

## Decision 5: bounded metrics

Spans can carry per-run detail. Metrics cannot: every distinct attribute value is a new time series, and a time series per run id would sink a metrics backend. So execution, workflow, node, session and client ids live on spans only.

The gateway needs a second version of the rule. On `mcp.client.operation.duration`, the tool name is a useful attribute: an admin chose which servers and tools exist. On the MCP gateway's `mcp.server.operation.duration`, outside callers choose the method and tool names, so a hostile client could invent a new name per request. The gateway's histogram carries no tool name, an unknown method is recorded as `_OTHER`, and a JSON-RPC error code outside the range JSON-RPC reserves (-32768 to -32000) is `_OTHER` on the metric (the span keeps the code). Whoever controls an attribute's values controls your metric's cardinality.

## Keeping the trace across queues, instances and approvals

Agent work often leaves the request that started it. A trace that stops at the queue is half a trace.

- **Queued runs.** When a job is enqueued while a span is active, its payload carries that span's `traceparent`. The worker, on whichever instance claims the job, opens a `process l2m.queue` CONSUMER span under it, with the time the job waited (`l2m.queue.wait_ms`). No schema change was needed: the context is a few characters in JSON that is stored anyway.
- **Approvals.** A run that pauses for a <Term id="human-in-the-loop">human decision</Term> stores the `traceparent` of the node that paused. When someone approves it, hours or days later, the resumed run is a new `invoke_workflow` span whose parent is the approver's request, with a span **link** to the paused node. A link, not a parent: they are separate pieces of work, and a parent span that "lasts" three days would distort every duration chart.
- **MCP servers.** Each request to an MCP server after the handshake carries the trace context in `params._meta`, as the MCP conventions recommend, and over HTTP in headers too. A server that rejects unknown fields can be excluded per server.

## Whose trace do you continue?

A caller can send a `traceparent` header, and continuing it is what joins your spans to theirs. But W3C Trace Context warns that when a public service naively continues any trace with the sampled flag set, "a malicious attacker could overwhelm an application with tracing overhead" or forge trace-id collisions, and it suggests "different tracing behavior for authenticated and unauthenticated requests".

L2M does exactly that by default (`L2M_OTEL_TRUST_INBOUND=authenticated`). A request that carries a valid credential (a signed-in session, an API key, a gateway client token), or that comes through a proxy you list in `L2M_OTEL_TRUSTED_PROXIES`, continues its caller's trace. Anyone else, such as a public webhook, starts a new trace that links to theirs. The credential check only reads the credential: it does not count as key use or session activity. Outbound, trace context goes to MCP servers and queue workers; model providers get none unless you set `L2M_OTEL_PROPAGATE_TO_PROVIDERS=true`, because their endpoints are outside your trace domain.

## When you do want the content

Seeing the prompt next to the latency helps find agent bugs. So content capture exists, off by default, behind `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` (`SPAN_ONLY`, `EVENT_ONLY` or `SPAN_AND_EVENT`). With `SPAN_ONLY`, `chat` spans in workflow runs carry the conventions' message attributes and `execute_tool` spans carry the tool call's arguments and result; `EVENT_ONLY` puts a model call's content in a span event instead. `/v1` AI gateway requests need a second opt-in, and evals, MCP sampling and gateway proxying record none.

Nothing is put on a span as it was handed over. When a span ends, it is held back from the exporter while L2M, off the request path, removes the secret values the deployment knows (6 characters or longer), <Term id="masking">masks</Term> personal data with stable keyed surrogates (the same email becomes the same token on every span, so you can still group by it), cuts long attributes while keeping valid JSON, and checks once more for secrets.

The interesting part is what happens when that fails. The span is still exported, without any content, and `l2m.content.dropped` says why: for example masking failed or timed out, a secret survived the final check, too many spans were waiting, or the work was sensitive. The OpenTelemetry page lists every reason. Fail closed, but keep the timing data; a trace with a hole and a reason is more useful than no trace. The sensitive case has a story of its own, because "sensitive" has to survive memory, retries and knowledge bases: we wrote it up in [Keeping sensitive data out of traces across runs](/blog/keeping-sensitive-data-out-of-traces).

## How we test it

`node scripts/otel-smoke.mjs` checks the whole path with no outside service. It starts a small OTLP receiver, starts the API on a temporary database, runs the zero-key MCP agent quickstart with a `traceparent`, stops the API with `SIGTERM`, and checks that one trace holds the request, run, nodes, agent loop, model call and the MCP `tools/list` call, with the right parents from the request down to the model call, that the metrics arrived, that nothing was exported before the stop (so the exit flush works), and that no secret value appears in anything sent. The API test suite runs it in both OTLP encodings (it skips it when a local `apps/api/.env` exists or `TEST_POSTGRES_URL` is set).

## What it does not do

- It does not capture content by default, and with capture on it does not capture embedding inputs, retrieval queries or anything on run, node or gateway SERVER spans.
- It does not send trace context from HTTP Request nodes or other outbound calls of a workflow.
- Masking replaces what the deployment can detect and the secrets it knows, not every personal detail a prompt can hold. Restrict who can read traces in your backend.
- The GenAI and MCP conventions it follows are experimental upstream and may still change.

## Try it in L2M

The [OpenTelemetry page](/operations/opentelemetry) starts with a local collector you can start with Docker (`ops/otel/docker-compose.yml`), then lists every span, metric and setting. Run the **MCP Agent Quickstart** template (echo model, built-in mock MCP server, no API key) and a trace like the one above arrives in the collector's output: the request, the run, its nodes, `tools/list`, the agent loop and its `chat` span. The echo model never calls a tool, so `execute_tool` and `tools/call` appear once you attach a real model. [Observability](/operations/observability) covers logs and the Prometheus page, which do not need OpenTelemetry.

## Further reading

- [GenAI spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-spans.md), [GenAI agent spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-agent-spans.md) and [MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/mcp.md), v1.41.0 (OpenTelemetry)
- [Trace Context](https://www.w3.org/TR/trace-context/), sections 6 and 7 on privacy and security (W3C)
- Concepts: [What is an AI agent?](/learn/agents/what-is-an-ai-agent), [LLM cost control](/learn/operations/llm-cost-control)
- Pull requests: [#197 tracing on the OpenTelemetry SDK](https://github.com/TensorGreed/l2m/pull/197), [#199 run, node and agent spans](https://github.com/TensorGreed/l2m/pull/199), [#206 model, MCP and queue spans](https://github.com/TensorGreed/l2m/pull/206), [#211 content capture and trace ids on runs](https://github.com/TensorGreed/l2m/pull/211) (GitHub)
