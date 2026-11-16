---
title: "OpenTelemetry: traces, metrics and logs, defined"
term: "OpenTelemetry"
topic: operations
definition: "An open standard and set of tools for producing traces, metrics and logs and sending them, over its own protocol (OTLP), to any compatible backend."
description: "OpenTelemetry is the open standard and toolkit for traces, metrics and logs. What a span is, how OTLP exports, and what it means for AI agents."
related: [genai-semantic-conventions, trace-context-propagation, tool-call-telemetry, agent-loop, mcp-client]
---

# OpenTelemetry

**An open standard and set of tools for producing traces, metrics and logs and sending them, over its own protocol (OTLP), to any compatible backend.**

OpenTelemetry (often shortened to OTel) gives applications a common API, SDKs and data model for telemetry, so an application is instrumented once and its data can go to any backend that accepts it. It deals with three main signals:

- **Traces**: the path of one request through a system, made of spans.
- **Metrics**: numbers measured over time, such as request counts or latency histograms.
- **Logs**: timestamped records of events.

A **span** is one unit of work: a name, start and end times, a parent span (empty for the first span of a trace), attributes, events, links and a status. Each span also has a kind: client, server, internal, producer or consumer. Spans that share a trace id form a tree, and <Term id="trace-context-propagation">trace context propagation</Term> carries that id from one service to the next.

**OTLP** is the protocol for sending the data. It runs over gRPC (port 4317 by default) or HTTP (port 4318), with paths such as `/v1/traces`, `/v1/metrics` and `/v1/logs`, and protobuf payloads in binary or JSON. The **Collector** is an optional process that receives, processes and exports telemetry: it can batch, retry, filter out sensitive data and fan out to several backends.

For AI agents, a trace turns one run into a readable tree: the agent loop, each model call with its token counts, each tool call and the MCP request behind it. The <Term id="genai-semantic-conventions">GenAI semantic conventions</Term> name those spans and attributes so any backend can read them.

## Example

```
invoke_agent support-bot
├─ chat gpt-4o                      client   gen_ai.usage.input_tokens=812
└─ execute_tool lookup_order
   └─ tools/call lookup_order       client   the request to the MCP server
```

## Common confusion

OpenTelemetry is not a backend. It produces and moves telemetry; storing, searching and drawing it is left to other tools. It is also not the same as a log file or a Prometheus page: those are other ways to expose data, and a system can offer them next to OTLP.

## In L2M

[OpenTelemetry export](/operations/opentelemetry) is off by default: with none of its settings set, the API loads no OpenTelemetry code. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and L2M exports traces over OTLP/HTTP (protobuf or JSON; gRPC is not shipped), and metrics too with `OTEL_METRICS_ENABLED=true`. It does not export logs over OTLP. The [traced spans](/operations/opentelemetry#what-is-traced) cover HTTP requests, runs, nodes, agent loops, model calls and MCP calls. Spans carry names, timings and token counts, not prompts or tool results, unless you turn on [content capture](/operations/opentelemetry#content-capture). To route them through a Collector, see [Send AI agent traces to an OpenTelemetry Collector](/learn/operations/opentelemetry-collector-for-agents); for how the span names compare with the GenAI semantic conventions, see [Map agent traces to OpenTelemetry GenAI conventions](/learn/operations/opentelemetry-genai-conventions).

## Further reading

- [What is OpenTelemetry?](https://opentelemetry.io/docs/what-is-opentelemetry/) (opentelemetry.io)
- [Traces](https://opentelemetry.io/docs/concepts/signals/traces/) (opentelemetry.io): spans and span kinds
- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) (opentelemetry.io)
- [Collector](https://opentelemetry.io/docs/collector/) (opentelemetry.io)
