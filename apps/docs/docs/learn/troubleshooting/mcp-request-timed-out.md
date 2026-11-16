---
title: "MCP \"Request timed out\": long tool calls and retries"
sidebarTitle: "Request timed out"
description: "Why MCP tool calls time out, what -32001 does and does not mean, how cancellation and progress work, and when a retry is safe or could act twice."
level: intermediate
about: mcp-tool
related: [mcp-tool, tool-annotations, stdio-transport, streamable-http, human-in-the-loop]
---

# MCP error -32001: Request timed out

"Request timed out" means the client stopped waiting: the server did not answer a request, usually `tools/call`, within the client's timeout, so the client gave up and cancelled it. The server may still have done the work. Fix it by making the tool answer sooner or raising the timeout for that one server, and be careful with retries, because sending the call again can run it twice.

## What it means

**The code is a client-side convention, not a protocol rule.** JSON-RPC 2.0 reserves `-32000` to `-32099` for "implementation-defined server-errors". The 2026-07-28 MCP revision splits that range: `-32000` to `-32019` stays implementation-defined, with existing SDK usage grandfathered (new implementations should not use it, and receivers must not assume a meaning for its codes, apart from `-32002`), and `-32020` to `-32099` is reserved for the specification. The official TypeScript SDK defines `RequestTimeout = -32001` (and `ConnectionClosed = -32000`) and formats errors as `MCP error <code>: <message>`, which produces the familiar "MCP error -32001: Request timed out". The SDK creates this error in the client when its timer fires; the server never sent it. Other implementations may use `-32001` for something else, so do not read meaning into the number alone.

**What the specification asks of timeouts.** The lifecycle section says implementations should set a timeout on every request they send. When it expires, the sender should send a cancellation notification and stop waiting. Implementations may reset the timer when a progress notification for that request arrives, "as this implies that work is actually happening", but should always enforce a maximum timeout whatever progress says.

**What the TypeScript SDK does by default.** In its 1.x releases (checked in 1.32), a request times out after 60 seconds unless the caller passes another `timeout`. Progress resets the timer only when the caller sets `resetTimeoutOnProgress`, which is off by default. With resets on, an optional `maxTotalTimeout` caps the total; the SDK checks it when a progress notification arrives. On timeout the SDK sends `notifications/cancelled` with the request id. Clients built on the SDK can change all of this, so check your client's own setting.

**Cancellation is a request, not a guarantee.** The cancellation utility says a receiver should stop processing and send no response, but may ignore the notice if the request is unknown, already finished or cannot be cancelled. A notice can also arrive after the work completed. So after a timeout you do not know whether the tool ran, half ran, or never started.

## Causes (most to least likely)

1. **The tool is slow.** A large query, a crawl, a build or a report takes longer than the client's timeout. Default timeouts are often a minute or two, while real jobs can take longer.
2. **The server is waiting on something else.** An upstream API is rate limiting it, a lock is held, or the tool waits for a person to approve something. The process is alive but makes no progress.
3. **Slow first start.** A stdio server launched with `npx` or `uvx` may download its package on first use, so the first request after a restart takes much longer than later ones.
4. **The answer never arrives.** The server wrote its response to a log instead of stdout, answered with the wrong id, or a reverse proxy buffers the streamed HTTP response until it ends. From the client's side this looks the same as a slow tool.
5. **Progress is sent but does not help.** The server reports progress, but the client does not reset its timer on progress, or its maximum timeout has been reached.
6. **An outer limit fires first.** The host has its own run or turn budget, or a proxy or load balancer closes idle connections before the MCP timeout. A proxy usually shows up as an HTTP `504` or a closed connection rather than this message.

## How to check

**Time the call outside your client.** For a stdio server, pipe the requests into it and time it. This uses the repository's echo server; replace the command and the tool call with yours:

```bash
time (printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"},"_meta":{"progressToken":"t1"}}}' \
  | node samples/mcp-echo-server/server.mjs)
```

The process exits when its input closes, so for a slow tool keep stdin open (for example with `cat` after the `printf`) and stop it yourself. Lines with `"method":"notifications/progress"` show whether the server reports progress at all.

For an HTTP server, `curl` shows the time and enforces its own ceiling with `-m`:

```bash
curl -s -m 600 -o /dev/null -w 'HTTP %{http_code} in %{time_total}s\n' \
  -X POST https://mcp.example.com/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"build_report","arguments":{}}}'
```

A real server may also need the protocol version and session headers your client sends. If the call finishes in 90 seconds by hand and fails after 60 in the client, the client's timeout is the cause.

**Read the server's log.** Look for the request arriving, for the moment it finished, and for a cancellation notice. A request that never arrives is a transport problem (see [Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed) or [Session not found](/learn/troubleshooting/mcp-session-not-found-404)); one that finished after the client gave up is a timeout that should be raised or avoided.

**Check the side effects before anything else.** If the tool writes, look at the target system: was the ticket created, the row inserted, the email sent?

## Fix

- **Raise the timeout for that one server or tool**, not globally, and keep a maximum. A higher timeout for a report tool is fine; an unlimited one turns a hung server into a hung agent.
- **Make the tool answer sooner.** Narrow the query, paginate, or return a summary and a link to the full result. A tool that runs for minutes is often two tools.
- **Turn long jobs into start-and-check.** A `start_export` tool returns a job id at once, and a `get_export_status` tool reports on it. The agent can poll, and nothing waits on one long request. The 2026-07-28 revision moves tasks, the protocol's own version of this pattern, into an official extension.
- **Report progress** from long tools. It helps clients that reset their timer on progress, and shows people that work is happening.
- **Make writes safe to repeat.** Accept an idempotency key as a tool argument so a repeated call returns the first result instead of acting again, and mark tools honestly with `readOnlyHint` and `idempotentHint` (see [tool annotations](/learn/mcp/tool-annotations)).
- **Retry only what is safe.** Retry reads and idempotent tools freely. For other writes, check the side effects first, or ask a person: an automatic retry after a timeout is how a payment or an email goes out twice.

## If you run agents in L2M

**Timeouts.** Each server's connection has a `timeoutMs`, 120000 ms (two minutes) by default, for HTTP and stdio servers. A server's **Call timeout** in its [runtime limits](/product/mcp-server-registry#rate-limits-concurrency-and-the-circuit-breaker), or a per-tool rule, overrides it. The messages are "MCP request timed out after …ms." for HTTP servers and "MCP stdio request 'tools/call' timed out after …ms." for stdio servers; with a call timeout set, the message names the tool, the server and "the server's call timeout". The error kind is `timeout`, and timeouts count against the server's circuit breaker.

**Cancellation.** When a call times out, L2M cancels it on the server: `notifications/cancelled` for stdio servers and for HTTP servers using the `initialize` handshake, and closing the request for 2026-07-28 HTTP servers ([progress and cancellation](/product/mcp-server-registry#progress-and-cancellation)).

**Progress does not extend the timeout.** L2M shows a server's progress on the run tape, but its timeout per call is fixed. The connection's timer pauses only while L2M itself answers a request from the server during the call, such as an elicitation waiting for a person, and then starts again from zero. A **Call timeout** from runtime limits does not pause: it ends the call one second after it expires, whatever the call is waiting for.

**Retries follow the safe re-send rule.** After a timeout on an HTTP server, L2M sends a tool call again only when the tool is read-only or idempotent (a timed-out stdio call is not sent again), by an admin's mark in tool policy or by the server's annotations. Other calls fail with the kind `timeout`, so the agent or the workflow can decide, for example by asking a person through an [approval](/learn/agents/human-in-the-loop) ([the safe re-send rule](/product/mcp-2026-07-28#the-safe-re-send-rule)). A broken connection after sending gives `outcome_unknown` instead.

**The run has its own limit.** `WORKFLOW_EXECUTION_TIMEOUT_MS` caps a whole run, 300000 ms (five minutes) by default; the repository's `.env.example` sets 1200000. A long agent run with several slow tools can hit it before any single call times out.

**A `-32001` from L2M is not a timeout.** L2M answers `-32001` when it refuses a server's own request, for example "Sampling is not available for this call: no model is attached to it." If a server's log shows `-32001` coming from L2M, read the message, not the code.

**When L2M is the server.** Clients calling workflows through the [MCP gateway](/product/mcp-gateway#the-endpoint) can send a `progressToken`; the gateway then streams one progress step per completed node, which keeps clients that reset their timer on progress waiting. Cancelling the call cancels the workflow run.

If the call finishes but returns more than the model can take, see [Tool result too large](/learn/troubleshooting/mcp-tool-result-too-large). If the agent keeps calling the same slow tool, see [Agent stuck in a tool loop](/learn/troubleshooting/agent-stuck-in-tool-loop).

## Further reading

- [MCP specification, 2025-11-25: Lifecycle, timeouts](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification), section 5.1 (jsonrpc.org)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (GitHub)
- In L2M: [Progress and cancellation](/product/mcp-server-registry#progress-and-cancellation), [The safe re-send rule](/product/mcp-2026-07-28#the-safe-re-send-rule), [Tool annotations](/learn/mcp/tool-annotations)
