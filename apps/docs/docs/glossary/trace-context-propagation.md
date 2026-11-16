---
title: "Trace context propagation: W3C traceparent"
term: "Trace context propagation"
topic: operations
definition: "Passing a trace's identity from one service to the next, usually in the W3C `traceparent` and `tracestate` headers, so that every hop of a request joins one distributed trace."
description: "Trace context propagation passes the W3C traceparent header between services so one request becomes one trace. Header format, sampling and trust."
related: [opentelemetry, genai-semantic-conventions, tool-call-telemetry, mcp-client, mcp-gateway]
---

# Trace context propagation

**Passing a trace's identity from one service to the next, usually in the W3C `traceparent` and `tracestate` headers, so that every hop of a request joins one distributed trace.**

One user request to an agent can touch a web server, a queue, a worker, a model provider and three MCP servers. Each records its own spans. Without a shared id they are separate stories; with one, a tracing backend can draw the whole request as a tree. Propagation is how that id travels: the caller writes it into the outgoing request, the receiver reads it and makes its spans children of the caller's.

The W3C Trace Context Recommendation (2021) standardises the headers, so different tracing tools can share a trace. `traceparent` has four fields: a version, a 16-byte `trace-id` (32 hex characters), the caller's 8-byte `parent-id` (16 hex characters) and `trace-flags`, whose lowest bit (`sampled`) says the caller may have recorded the trace. `tracestate` is a companion header for vendor-specific data. The specification says neither may be used for personally identifiable information.

## Example

```http
POST /api/workflows/wf_123/execute HTTP/1.1
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
```

The receiver keeps the trace id `0af76519…`, makes its server span a child of `b7ad6b71…`, and sees `01`: sampled. When it calls the next service, it sends the same trace id with its own span id as the new `parent-id`.

## Common confusion

- **Propagation is not export.** Headers carry ids between services; spans still have to be exported to a backend.
- **An inbound `traceparent` is a claim, not a fact.** A caller can force sampling on or off, or attach your spans to its trace. The specification says vendors should not strictly trust caller flags, may restart a trace at a front gate into a secure network, and may treat authenticated and unauthenticated requests differently.
- **Not every hop is HTTP.** A queue job or other message carries the context inside the message itself.

## In L2M

With [OpenTelemetry](/operations/opentelemetry) turned on (off by default), L2M reads an inbound `traceparent` and, by default, continues it only for [trusted callers](/operations/opentelemetry#inbound-trace-context-and-who-is-trusted): a request with a valid credential or from a listed proxy. Anyone else gets a new trace that links to theirs. It sends trace context to MCP servers in `params._meta` and, over HTTP, as headers ([opt-out per server](/operations/opentelemetry#trace-context-sent-to-mcp-servers)), and to [queued jobs](/operations/opentelemetry#queues-clusters-and-approvals) so a worker on any instance continues the trace. It sends nothing to model providers unless `L2M_OTEL_PROPAGATE_TO_PROVIDERS=true`, and HTTP Request nodes do not send it.

## Further reading

- [W3C Trace Context (Recommendation)](https://www.w3.org/TR/trace-context/) (w3.org)
