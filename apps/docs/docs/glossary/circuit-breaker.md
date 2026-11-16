---
title: "Circuit breaker for AI tool calls"
term: "Circuit breaker"
topic: mcp
definition: "A wrapper around calls to another service that, after enough failures, stops sending calls for a while and fails them at once, then lets a trial call through to see if the service is back."
description: "A circuit breaker stops calling a failing server for a while so errors don't pile up. How it applies to MCP servers and which errors should count."
related: [mcp-server, tool-calling, rate-limit, idempotency, tool-call-telemetry]
---

# Circuit breaker

**A wrapper around calls to another service that, after enough failures, stops sending calls for a while and fails them at once, then lets a trial call through to see if the service is back.**

When a server is down or hanging, every caller waits for its timeout, and the waits pile up. Michael Nygard popularised the pattern in his book *Release It!*; Martin Fowler's short article describes it as wrapping a protected call in an object that watches for failures.

A breaker has three states:

- **Closed**: calls go through, and failures are counted.
- **Open**: after a threshold of failures, calls fail at once without reaching the service, for a cool-down period.
- **Half-open**: after the cool-down, one trial call goes through. Success closes the breaker; failure opens it again.

For an agent, a breaker turns a dead MCP server into a fast, clear error. The model gets "circuit open" right away and can answer without that tool, instead of each <Term id="tool-calling">tool call</Term> burning a full timeout.

## Example

A ticket-search server stops answering. Five calls in a row time out, and the breaker opens for 30 seconds. During that time the agent's calls to `search_tickets` fail at once. After 30 seconds one call is let through. It succeeds, so the breaker closes and normal traffic resumes.

## Common confusion

The hard part is deciding which errors count. Fowler notes that not all errors should trip the circuit. A server that answers "invalid arguments" or "no such ticket" is healthy: the model made a bad call. Counting those would let one confused agent shut a working server off for everyone. Only signs that the server itself is failing (no connection, broken protocol, timeouts) should count.

A breaker is also not a <Term id="rate-limit">rate limit</Term>. A rate limit caps traffic to a healthy server; a breaker reacts to an unhealthy one.

## In L2M

Each server in the [MCP server registry](/product/mcp-server-registry#rate-limits-concurrency-and-the-circuit-breaker) has a breaker, on by default. It opens after 5 failures in a row, or when at least half of the calls in a 60-second window fail once there have been 10 calls; after a 30-second cool-down one probe call goes through. All of these numbers can be changed per server. Transport, protocol and timeout failures count, as does a call whose outcome is unknown after a broken connection. Tool errors, rejected arguments and output that fails its schema count as successes, because the server answered. Cancelled calls, missing credentials and sandbox refusals are not counted. Breaker state is kept in memory on each API instance. Admins can reset a breaker by hand, and every state change is audited.

## Further reading

- [CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html) (Martin Fowler, 2014)
- Michael T. Nygard, *Release It!* (Pragmatic Bookshelf)
