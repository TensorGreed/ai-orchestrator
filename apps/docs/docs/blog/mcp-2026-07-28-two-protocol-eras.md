---
title: "Supporting MCP 2026-07-28 next to older servers"
description: "What the stateless MCP revision changed, how a client and a gateway can speak both protocol eras over HTTP and stdio, and how we test it."
date: 2026-11-16
author: "The L2M team"
related: [model-context-protocol, mcp-client, mcp-gateway, stdio-transport, streamable-http, tool-annotations]
socialCard: true
---

# Supporting MCP 2026-07-28 next to older servers

The 2026-07-28 revision of the <Term id="model-context-protocol">Model Context Protocol</Term> changes the protocol's shape: the `initialize` handshake is gone, protocol sessions are gone, and every request describes itself. Between 12 and 13 November 2026 we merged support for it in L2M, as an <Term id="mcp-client">MCP client</Term> over HTTP and stdio and as a server on the <Term id="mcp-gateway">MCP gateway</Term>, next to the older revisions. This post explains what changed in the protocol, the problems that come with speaking two eras at once, and how we test that we got it right.

## What changed in the protocol

Earlier revisions (2025-11-25 and before; we call them **legacy** below) start every connection with a handshake. The client sends `initialize`, the two sides agree a version and capabilities, and over <Term id="streamable-http">Streamable HTTP</Term> the server hands back an `Mcp-Session-Id` that every later request carries. The session is state the server has to keep, and in a cluster it pins a client to one instance.

The 2026-07-28 changelog puts the change plainly: "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake." The parts that matter most to a client and a gateway:

- **Per-request metadata.** Every request carries its protocol version and client capabilities in `params._meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`), and HTTP requests add `Mcp-Method` and `Mcp-Name` headers.
- **`server/discover`.** Servers must implement it to advertise their versions and capabilities. Clients may call it first, or "use it as a backward-compatibility probe on STDIO".
- **Multi round-trip requests.** A server no longer sends its own requests to the client (elicitation, sampling, roots). It answers the original request with `resultType: "input_required"`, and the client sends the request again with the answers.
- **No stream resumption.** "A broken response stream loses the in-flight request; clients MUST re-issue it as a new request with a new request ID."
- **`subscriptions/listen`** replaces the standalone GET stream for change notifications.
- **Reserved error codes.** `-32020` to `-32099` now belong to the specification: header mismatch (`-32020`), missing client capability (`-32021`), unsupported version (`-32022`).

A client will meet servers that speak legacy, both, or only 2026-07-28 for a long time. So the question was never "how do we switch" but "how do we tell which one we are talking to, cheaply and without breaking what works".

## Telling the eras apart

Each MCP server in L2M has a protocol mode, `legacy`, `auto` or `modern`, set in its connection settings or as a deployment default (`MCP_CLIENT_PROTOCOL_DEFAULT`). The default is `legacy`, and that choice deserves an explanation, because it sounds like "no 2026-07-28 support".

It is not. A legacy client sends `initialize` first. A server that only speaks 2026-07-28 rejects it with one of the new error codes (over HTTP, a 400 with one of the new error codes, where `-32022` also lists the versions the server speaks; over stdio, an error that lists a 2026-07-28 version). L2M reads that answer, switches the server to 2026-07-28 and retries. So the default also reaches servers that only speak 2026-07-28, and the handshake with the servers you already have stays exactly as it was.

`auto` goes the other way round: it sends `server/discover` first and falls back to `initialize` when the answer says "legacy". The work is in deciding what counts as an answer over HTTP:

| Answer to `server/discover` | Verdict |
| --- | --- |
| A result, a recognised 2026-07-28 error, or 404 with `-32601` | 2026-07-28 |
| A client error with no such code, such as a plain 400 | Legacy: fall back to `initialize` |
| 401, 403, 407, 408, 429, a server error, or no answer in time | Nothing decided, nothing remembered |

The last row matters most: a server that is down or rate-limiting you has told you nothing about its protocol, and verdicts are cached per endpoint for an hour. When a cached verdict turns out wrong anyway, the operation runs once more in the other era.

## Stdio is harder than HTTP

This section is about `auto` mode, which probes first. Over HTTP the probe has status codes to lean on. Over the <Term id="stdio-transport">stdio transport</Term> there are none: L2M starts a process and writes JSON-RPC to its standard input. Three things we ran into:

- **Servers that exit on an unknown method.** Some legacy servers treat `server/discover` as fatal and quit. An exit on the probe therefore means legacy: L2M sends `initialize` on a new process and remembers the verdict per launch configuration (command, arguments, folder, environment and sandbox), so later runs do not start the process twice.
- **Slow starts.** A server installed by `npx` on first use can take longer than the probe timeout (`MCP_CLIENT_ERA_PROBE_TIMEOUT_MS`, 5 seconds by default). It is then remembered as legacy for the hour and still works over `initialize`. We chose a working, slightly slower path over failing a call.
- **Concurrent first calls.** Two calls in the same run that found no session each started a process, and the second replaced the first in the cache while the first ran on. Probing made that window longer. Now a start that is under way is shared, and other callers wait for it.

A fall-back between protocol versions is a small state machine per server, and every edge of it (exit, timeout, concurrency) needs a decision written down.

## When can you send a request again?

Removing stream resumption sounds like a transport detail. It is really a question about side effects. When a connection breaks after a request was sent, the client cannot know whether the server acted on it. Sending a `tools/call` again might issue a second refund.

L2M now sends a request again after a broken connection, a timeout, or (for 2026-07-28 servers) an early end of the stream only when that is safe. Legacy servers' requests are never sent again after an early end of the stream. The safe cases:

- any request that is not a tool call (listing, reading a resource, `server/discover`);
- a tool call to a tool marked read-only by an admin in [tool policy](/product/mcp-tool-policy#read-only-classification), or, without a mark, annotated read-only or idempotent by the server's <Term id="tool-annotations">tool annotations</Term> (`readOnlyHint`, `idempotentHint`). An admin's write mark overrides the server's `readOnlyHint` but not its `idempotentHint`: a tool the server calls idempotent is still sent again.

Any other call fails with the error kind `outcome_unknown` (or `timeout` after a timeout), which the agent and the run trace both see, so a workflow can route it to a person instead of guessing. A request that never reached the server (connection refused, DNS failure) is always retried. Over HTTP, an unsafe call is retried only on `429` and `503`, where the server did not act; `502` and `504` give `outcome_unknown`.

We applied the same rule to legacy servers by default, because the risk is the same whatever the protocol says. It is the most visible of a few changes that apply with no setting (the others tighten OAuth checks and scope errors; the [upgrade notes](/product/mcp-2026-07-28#what-changes-without-any-setting) list them all). `MCP_CLIENT_LEGACY_SAFE_REISSUE=false` restores the old behaviour. The better fix is to mark your read-only tools, so they keep being retried.

## Questions without an open connection

With multi round-trip requests, a server that needs a person's answer returns `input_required`. L2M answers through the same handlers it used before: an [elicitation](/product/mcp-server-registry#elicitation-a-server-asks-the-person-a-question) goes to a person, a sampling request goes through the sampling rules. Then it sends the original request again with the answers and the server's `requestState` exactly as received.

No upstream connection stays open while a person thinks. And `requestState` is opaque server state that may hold anything, so L2M never logs or records it, only its hash and length. A call fails after `MCP_CLIENT_MRTR_MAX_ROUNDS` rounds (5 by default) so a confused server cannot loop forever.

## Serving both eras on the gateway

The MCP gateway publishes L2M tools and workflows to outside clients. With `MCP_GATEWAY_MODERN_PROTOCOL=on` it serves 2026-07-28 clients on the same endpoint as session-based ones, without sessions. A request is treated as 2026-07-28 when it carries `MCP-Protocol-Version: 2026-07-28`, or a protocol version in `_meta` on any method but `initialize`. Trace context alone in `_meta` does not count, because older clients may send that too.

Calls run with a per-caller state keyed by the client token, the toolset and the user. On toolsets that track outside content, a caller's [data labels](/product/data-labels-and-destinations) are stored in the database, so every instance sees the same labels and a caller cannot clear them by reconnecting. Stateless callers need no sticky sessions in a cluster.

Two smaller choices:

- **Error codes moved.** The gateway's own codes (retry later, approval pending, approval rejected, budget exceeded) sat in the range 2026-07-28 now reserves. For 2026-07-28 callers they move to `-31029` to `-31032`; session clients keep the old ones.
- **Mode off answers like a legacy server.** With modern mode off, a 2026-07-28 request gets the legacy error, which a client that speaks both reads as "fall back to `initialize`". A client that speaks only 2026-07-28 cannot connect until you turn the mode on.

`subscriptions/listen` streams that ask for tool list changes get `notifications/tools/list_changed` when the list that client would see changes. Changes travel between instances over the cluster bus, and each stream's list is also re-checked every 30 seconds by default (`MCP_GATEWAY_LISTEN_CHECK_MS`), to catch changes nobody announced.

## Testing it against the official suite

CI runs the official MCP conformance suite (`@modelcontextprotocol/conformance`) against L2M in both directions: the gateway with modern mode on and off, and the HTTP client, for 2025-11-25 and 2026-07-28, plus the OAuth and back-compat suites. Locally it is one command, `node apps/api/conformance/run.mjs`.

Each run has a baseline file listing the scenarios expected to fail, each with a reason. The runner fails on a new failure and also on a listed scenario that starts passing, so the lists can only shrink. That second rule is the useful one: a fix that makes a scenario pass fails the job until someone deletes its line, and the baseline never drifts into a list of excuses.

Running it caught details we had wrong. One example: the gateway checked whether the version in `_meta` was supported before comparing it with the `MCP-Protocol-Version` header, so a request whose header said 2026-07-28 while its `_meta` named a version the gateway does not speak got "unsupported version" (`-32022`) instead of "header mismatch" (`-32020`). The order of checks is now part of the [support page](/product/mcp-2026-07-28#what-modern-mode-serves), because a client's error handling depends on it. The current pass and fail counts, and the reason for each remaining failure, are listed under [conformance](/product/mcp-2026-07-28#conformance).

## What it does not do

- The gateway serves tools only. Resources, prompts, completion and logging get `-32601`, and `subscriptions/listen` honours tool list changes only.
- The gateway never asks its callers for input: an upstream server's elicitation or sampling request during a gateway call is declined.
- L2M declares no roots, no URL-mode elicitation and no tasks extension.
- The 2025-03-26 OAuth fallback, where the MCP server doubles as its authorization server, is not supported.
- The server page does not yet show which era a server answered with; set the mode when you need to know.
- Probing first is opt-in: the client default stays `legacy`, which still reaches 2026-07-28-only servers after a rejected `initialize`, and modern mode on the gateway stays off until you turn it on. The safety changes in the upgrade notes do apply by default.

## Try it in L2M

The [MCP 2026-07-28 support page](/product/mcp-2026-07-28) lists every setting and the upgrade steps. Start by marking read-only tools in [MCP tool policy](/product/mcp-tool-policy), then set **Auto** on a server you know speaks 2026-07-28. With [OpenTelemetry](/operations/opentelemetry#mcp-spans-and-trace-context) on, MCP spans carry `mcp.protocol.version`, so you can see which era each call used. For the concepts, read [MCP transports](/learn/mcp/transports) and [MCP authorization](/learn/mcp/authorization).

## Further reading

- [MCP 2026-07-28 key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (MCP specification)
- [Multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) (MCP specification)
- [MCP conformance suite](https://github.com/modelcontextprotocol/conformance) (GitHub)
- Pull requests: [#188 protocol foundations](https://github.com/TensorGreed/ai-orchestrator/pull/188), [#197 HTTP client and gateway](https://github.com/TensorGreed/ai-orchestrator/pull/197), [#206 stdio client and conformance in CI](https://github.com/TensorGreed/ai-orchestrator/pull/206), [#211 conformance fixes and `subscriptions/listen`](https://github.com/TensorGreed/ai-orchestrator/pull/211), [#212 tool list notices on listen streams](https://github.com/TensorGreed/ai-orchestrator/pull/212) (GitHub)
