---
title: "Tracing vs logging for LLM and agent apps"
sidebarTitle: "Tracing vs logging"
description: "Logs record events; traces connect a model call, its tool calls and the servers behind them. What to capture, what to keep out, and the GenAI conventions."
level: intermediate
about: opentelemetry
related: [opentelemetry, genai-semantic-conventions, trace-context-propagation, tool-call-telemetry, audit-log, pii]
---

# Tracing vs logging for LLM and agent apps

A log line records one event: "request completed", "model call failed", "tool timed out". A trace records one request as a tree of timed steps, called spans, with parents and children. In a plain web app the difference is a matter of convenience. In an LLM or agent app it decides whether you can answer the basic questions. One user request turns into several model calls, the tool calls the model asked for, the servers behind those tools, and sometimes a queue job or a run resumed after a person approves a step. Logs show each event on its own. A trace shows which call caused which, and where the time and tokens went. You need both, joined by a trace id on every log line. Keep prompts, answers and tool arguments out of both by default.

## Side by side

| | Logs | Traces |
| --- | --- | --- |
| Unit | One event, as a line or a record | One request, as a tree of spans |
| OpenTelemetry's definition | "A recording of an event." | "The path of a request through your application." |
| Answers | What happened, and with what error? | What caused what, in which order, and how long did each step take? |
| Structure | Flat; related lines share an id | Parent and child spans; links between related traces |
| Crosses services | Only if every service logs the same id | Yes, through `traceparent` and `tracestate` headers |
| Typical volume control | Log levels | Sampling: at the start (head) or after the trace is complete (tail) |
| Good for | Errors with details, start-up settings, background jobs, anything outside a request | Latency breakdown, fan-out, tool chains, work that hops between services |
| Weak at | Reconstructing a whole agent run | Free-text detail; events that belong to no request |

Metrics are the third signal: counts and histograms, such as tokens per model or tool-call latency, that stay cheap however much traffic you have. They answer "how often" and "how much", not "what happened in this run".

<figure>
<svg viewBox="0 0 640 250" role="img" aria-labelledby="tl-fig-title tl-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="tl-fig-title">One agent run as log lines and as a trace</title>
  <desc id="tl-fig-desc">On the left, four flat log lines, each with the same trace id. On the right, the same run as a tree: an agent span containing two model call spans and a tool call span, with an MCP server call under the tool call.</desc>
  <g font-family="inherit" font-size="12" fill="currentColor">
    <text x="20" y="20" font-size="13" font-weight="600">Logs: one line per event</text>
    <rect x="20" y="32" width="270" height="200" rx="8" fill="none" stroke="currentColor"/>
    <text x="32" y="60">10:02:01 run started</text>
    <text x="32" y="78" font-size="11">trace_id=4bf9…</text>
    <text x="32" y="106">10:02:03 tool lookup_order ok</text>
    <text x="32" y="124" font-size="11">trace_id=4bf9…</text>
    <text x="32" y="152">10:02:09 model call slow</text>
    <text x="32" y="170" font-size="11">trace_id=4bf9…</text>
    <text x="32" y="198">10:02:09 run completed</text>
    <text x="32" y="216" font-size="11">trace_id=4bf9…</text>
    <text x="350" y="20" font-size="13" font-weight="600">Trace: one tree per request</text>
    <rect x="350" y="32" width="270" height="30" rx="6" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="362" y="52">invoke_agent support-bot (8.1 s)</text>
    <rect x="375" y="74" width="245" height="30" rx="6" fill="none" stroke="currentColor"/>
    <text x="387" y="94">chat (1.4 s)</text>
    <rect x="375" y="116" width="245" height="30" rx="6" fill="none" stroke="currentColor"/>
    <text x="387" y="136">execute_tool lookup_order (0.6 s)</text>
    <rect x="400" y="158" width="220" height="30" rx="6" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <text x="412" y="178">tools/call → MCP server</text>
    <rect x="375" y="200" width="245" height="30" rx="6" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="387" y="220">chat (6.0 s, the slow step)</text>
    <path d="M362 62 L362 89 L375 89 M362 89 L362 131 L375 131 M362 131 L362 215 L375 215" stroke="currentColor" fill="none"/>
    <path d="M387 146 L387 173 L400 173" stroke="currentColor" fill="none"/>
  </g>
</svg>
<figcaption>The same run twice. The log lines share a trace id, so you can find them all, but only the trace shows that the second model call took most of the eight seconds.</figcaption>
</figure>

## What logs do well

Logs are cheap to write, easy to search and need no special backend. They are the right place for:

- **Errors with their details.** A stack trace, a provider's error message or a configuration problem fits a log line, not a span attribute.
- **Things that belong to no request.** Start-up settings, a scheduler firing, a retention purge, a lost connection to the database.
- **A quick look.** `grep` on a request id still beats any query language when a service is down.

Write them as structured records, such as JSON with fixed field names, not free text. OpenTelemetry defines a structured log as "a log with a defined, consistent schema or typed fields". Then every line can carry the ids that tie it to the rest of the system.

## What traces do well

An agent's run is a chain of decisions, and its cost and latency come from that chain. A trace answers questions a pile of log lines cannot:

- **Where the time went.** Was the run slow because of the model, a tool, the MCP server behind the tool, or a queue wait?
- **Where the tokens went.** With the token counts on each model call span, you can see which turn of the loop used the most context.
- **Which call caused which.** The model asked for a tool, the tool called a server, and the server's error came back as the next prompt. Parent and child spans show this order.
- **Work that leaves the process.** With W3C Trace Context, which "defines standard HTTP headers and a value format to propagate context information", the trace continues into an MCP server or a queue worker that supports it: each hop's `traceparent` header carries the same trace id. Work that resumes much later, such as a run continued after an approval, joins with a span link rather than a parent.

The OpenTelemetry <Term id="genai-semantic-conventions">GenAI semantic conventions</Term> give these spans shared names, such as `chat {model}`, `execute_tool {tool}` and `invoke_agent {agent}`, so any tracing backend can draw an agent timeline. [Mapping your traces to them](/learn/operations/opentelemetry-genai-conventions) covers the names in detail.

## What to capture, and what to keep out

The same rule applies to both signals: record ids, names, numbers and outcomes; keep content out unless you have a reason and a plan.

**Capture on every model call:** provider, requested and returned model, input and output tokens, finish reason, duration, retry count, error type. **On every tool call:** tool name, call id, the server it went to, outcome (ok, error, refused, waiting for approval), duration. **On the run:** the ids that link it to your own records, so someone can go from a trace to the run and back.

**Keep out by default:** prompts, model answers, tool arguments and tool results. They hold <Term id="pii">personal data</Term>, customer documents and sometimes secrets, and tracing and log backends are usually read by more people, and kept longer, than your database. The GenAI conventions agree: their content attributes are opt-in and "are not recorded by default when content capturing is disabled". When you do need content to debug an agent, turn it on deliberately, mask it before export, restrict who can read it and keep it briefly. [Keeping personal data out of prompts, logs and traces](/learn/security/sensitive-data-in-prompts) covers masking.

**Keep ids off metrics.** A run id or user id as a metric attribute creates a new series for every run. Put those on spans and log lines.

## Sampling changes the picture

Logs are usually all kept, filtered by level. Traces are often sampled. OpenTelemetry describes head sampling as a decision made "as early as possible", without seeing the whole trace, and tail sampling as a decision made "by considering all or most of the spans within the trace". Head sampling at 10% throws away 90% of failed runs too. If you sample, keep every error trace with tail sampling in a collector, and make sure the logs of a dropped trace still carry its trace id, so the lines can be grouped even when the spans are gone.

## When to use which

- **A run failed and you need the reason:** start from the logs or the run's error, then open its trace to see which step failed and what led up to it.
- **Runs are slow or expensive:** use traces for one run and metrics for the trend.
- **You need proof of who changed what:** neither. That is an <Term id="audit-log">audit log</Term>, with its own retention and protection; see [audit trails for AI agents](/learn/operations/audit-trails-for-agents).
- **You need the full inputs and outputs of a run:** your app's own run history, under its access control and retention, not a tracing backend.

## How they combine

The join is the trace id. OpenTelemetry's logging guidance says that with its SDK or auto-instrumentation in place, OpenTelemetry can "automatically correlate your existing logs with any active trace and span", which means each log line written inside a span carries `trace_id` and `span_id`. In practice:

1. Every log line written inside a request or run carries `trace_id` and `span_id`.
2. Your run records store the trace id, and the screen that shows a run links to its trace.
3. Spans carry your run id, so a trace leads back to the run.
4. Metrics stay aggregate and point to traces through exemplars or dashboards, not ids.

With that in place you can start anywhere (an alert, a support ticket, a slow-request graph) and reach the other two in one click.

## In L2M

L2M, a self-hosted workflow builder and agent runtime, keeps the three signals separate and joins them by id ([Observability](/operations/observability)):

- **Logs** are JSON lines on stdout, with `reqId` on every line of a request (also returned as `X-Request-ID`). `LOG_LEVEL` is `warn` by default; `info` adds request and run start and end lines.
- **Metrics** are on a Prometheus `/metrics` page, on by default, with run counts, durations and SLO numbers. They can also be pushed over OTLP.
- **Traces** are optional and off by default. With an OTLP endpoint set, L2M emits spans for each HTTP request, run, node, agent loop, model call, tool call and MCP request, following the GenAI and MCP conventions pinned at v1.41.0 ([OpenTelemetry](/operations/opentelemetry)). Spans carry ids and timings, not content. Content capture is a separate opt-in that masks before export ([content capture](/operations/opentelemetry#content-capture)).
- **The join.** While tracing is on, log lines carry `trace_id` and `span_id`. Each run stores its trace id, shown as **Copy trace id** on the run page, and `L2M_OTEL_TRACE_URL_TEMPLATE` adds an **Open trace** link. Spans carry `l2m.execution.id` to lead back to the run ([trace id on runs](/operations/opentelemetry#trace-id-on-runs)).
- **Records that are neither.** Run history keeps each run's inputs, outputs and node trace inside L2M, under `EXECUTION_HISTORY_RETENTION_DAYS`. [MCP tool-call telemetry](/product/mcp-tool-call-telemetry) keeps one row per tool call with a safe argument summary. The [audit log](/security/audit-log) records who changed the platform.

**Try it.** The [quick start with a local collector](/operations/opentelemetry#quick-start-with-a-local-collector) runs the zero-key MCP Agent Quickstart template and writes its spans to a file. Start the API with `LOG_LEVEL=info` as well, and the run's log lines carry the same trace id as its spans.

## Further reading

- [OpenTelemetry: Signals](https://opentelemetry.io/docs/concepts/signals/), [Traces](https://opentelemetry.io/docs/concepts/signals/traces/) and [Logs](https://opentelemetry.io/docs/concepts/signals/logs/) (opentelemetry.io)
- [OpenTelemetry: Sampling](https://opentelemetry.io/docs/concepts/sampling/) (opentelemetry.io): head and tail sampling
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) (W3C Recommendation): `traceparent` and `tracestate`
- [Semantic conventions v1.41.0: GenAI](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/README.md) (OpenTelemetry)
- L2M docs: [Observability](/operations/observability), [OpenTelemetry](/operations/opentelemetry)
