---
title: "Testing MCP tool calls: replay, mocks and checks"
sidebarTitle: "Testing MCP tools"
description: "Why live MCP calls make agent tests flaky, and what recorded replays, schema-built mocks and breaking-change checks each catch and miss."
level: intermediate
about: cassette
related: [cassette, snapshot-mock, breaking-change, mcp-tool, replay]
---

# Testing agents that call MCP tools

To test an agent that calls MCP tools, take the live servers out of the test. Record the calls a good run makes and answer them from that recording (a <Term id="cassette">cassette</Term>), stand in for a server with a mock built from its tool schemas, and check each server's schemas against the last version you accepted so a breaking change fails the build. Each technique catches a different kind of failure, and none of them proves the live server still works, so you need all three plus an honest list of what they miss.

## Why live MCP calls make flaky tests

An agent test that talks to real <Term id="mcp-server">MCP servers</Term> depends on things the test does not control:

- **The tool list can change.** The MCP specification lets a server announce that "the list of available tools changes" with a `notifications/tools/list_changed` message. A tool you relied on can be renamed, gain a required parameter or disappear between two runs.
- **Answers change.** A search tool returns different results each day. A ticket tool reads a queue that other people edit. The agent then takes a different path, and the test fails for a reason unrelated to your change.
- **Servers fail.** Timeouts, rate limits, expired tokens and outages all show up as test failures.
- **Calls have side effects.** A test of a refund agent that calls the real refund tool refunds someone.
- **Calls cost time and money.** A suite that hits paid APIs on every pull request gets slow and expensive, so people stop running it.

The model adds its own variation on top. If the tools also vary, a failing test tells you almost nothing about which part changed. The goal is to hold the tools still while you test the agent, and to test the tools' contracts separately.

## Record and replay: cassettes

A cassette is a recording of every MCP call one run made, in order: the server, the method (`tools/call`, `tools/list`, `resources/read` and so on), the tool name, the arguments, and the result or error. To <Term id="replay">replay</Term>, run the agent again and answer each MCP call from the recording instead of the server.

Three design choices decide whether a replay is useful:

1. **How a call is matched.** A practical key is the server, the method, the tool name and a hash of the arguments in a canonical form (sorted keys, so `{"a":1,"b":2}` and `{"b":2,"a":1}` match). Identical repeated calls get their recorded answers in order. Calls from parallel branches can arrive in any order, so order should only matter among identical calls.
2. **What happens on a miss.** If the agent now calls `search_orders` with `status: "open"` and the cassette only has `status: "all"`, there is no recorded answer. A strict replay stops and reports the miss. A lenient replay sends that call to the live server, which brings back the flakiness and the side effects you were avoiding. Strict should be the default; a miss usually means the agent's behaviour changed, which is exactly what you want to know.
3. **What never goes into the file.** Recordings end up in repositories and CI logs. Credentials, bearer tokens, API keys and secret values must be replaced before anything is written, and the arguments must be scrubbed before they are hashed, so a replay matches the same scrubbed form.

Replay is the right tool for "I changed the prompt, does the agent still do the right thing?" The tools answer exactly as they did when the run was good, so any difference comes from your change or from the model. Saving the whole run, not just the MCP traffic, gives you a <Term id="golden-run">golden run</Term>; the [regression testing guide](/learn/testing/regression-testing-agents) covers that, with verdicts and CI.

What replay does not tell you is whether the recording is still true. A cassette from March says what the server answered in March.

## Snapshot mocks: a stand-in server from the schemas

Sometimes there is no good run to record yet, or you need a server to exist on a laptop with no network: for a demo, for local development, or for a test of a path the recording never took. A <Term id="snapshot-mock">snapshot mock</Term> is a fake MCP server built from a snapshot of the real server's tools: their names, descriptions, input schemas and output schemas.

A useful mock does four things, in this order:

1. **Validates the arguments** against the tool's `inputSchema`. Invalid arguments get an error result, not a crash.
2. **Answers from a cassette** when it has a matching call, so recorded answers still win.
3. **Builds an example from the tool's `outputSchema`** when there is one: a `const`, the first `enum` value, a `default`, or a placeholder of the right type for each property.
4. **Falls back to a fixed text** for tools that declare no output schema.

The error behaviour matters, because it is where an agent's recovery logic gets tested. The MCP specification separates two kinds of error. **Protocol errors** are JSON-RPC errors for unknown tools, malformed requests and server errors. **Tool execution errors** are normal results with `isError: true`, used for API failures, input validation errors and business logic errors. The specification says tool execution errors "contain actionable feedback that language models can use to self-correct and retry", and that clients "SHOULD provide tool execution errors to language models". A mock that answers bad arguments with an `isError` result lets you check that your agent reads the error and fixes its call, instead of giving up or looping.

Here is a tool with an output schema, and what a schema-built mock might return for it:

```json
{
  "name": "get_order",
  "inputSchema": {
    "type": "object",
    "properties": { "order_id": { "type": "string" } },
    "required": ["order_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "status": { "type": "string", "enum": ["open", "shipped", "refunded"] },
      "total": { "type": "number" }
    },
    "required": ["status", "total"]
  }
}
```

A call with `{ "order_id": "A-1001" }` gets `structuredContent` such as `{ "status": "open", "total": 0 }`. A call with `{ "order": "A-1001" }` gets an `isError` result saying `order_id` is required. Both are deterministic, so a test that uses them gives the same answer every time.

A mock built from schemas is shaped right and means nothing. It will never say an order is refunded unless the recording does. Use it to test plumbing and error handling, not to judge whether the agent's answer is correct.

## Breaking-change checks in CI

Replays and mocks freeze the server. The third technique watches the real one. Treat each server's tool schemas as a contract: save a snapshot you accept, fetch the live `tools/list` in CI or on a schedule, and diff the two. A <Term id="breaking-change">breaking change</Term> is one that can make a call that worked yesterday fail today:

| Input schema change | Breaking? | Why |
|---|---|---|
| A tool is removed | Yes | Every call to it fails. |
| An input property is removed, or its type narrows or changes | Yes | Arguments the agent sends are now rejected. |
| A new required property, or optional becomes required | Yes | Old calls lack the field. |
| An enum loses a value | Yes | A value the agent uses is now invalid. |
| A tool or an optional property is added | No | Old calls still validate. |
| A type widens, an enum gains a value | No | Old values are still accepted. |
| A description or annotation changes | No (for the schema) | Calls still validate. |

Output schemas need the rules reversed, because the risk sits with the code that reads the result. Removing an output property, making a required one optional, widening a type or adding an enum value can all break a later step that expected the old shape. The specification makes the output schema a real promise: if a tool provides one, "Servers **MUST** provide structured results that conform to this schema" and "Clients **SHOULD** validate structured results against this schema."

Run the check in two places. On every pull request, so a workflow change that depends on a missing tool fails before merge. On a schedule, so a server that changes under you is caught before the next production run, not by it. Wire the result to an exit code (zero clean, non-zero on a breaking change or an unreachable server) and the CI system does the rest.

A schema diff is a contract test, not a security review. A changed description is compatible as far as calls go, but a description is text the model reads, and a server that quietly rewrites it after you approved it is the <Term id="rug-pull">rug pull</Term> pattern. List description changes in the report, and have someone read them. The [MCP security risks guide](/learn/security/mcp-security-risks) explains why.

## What a mock cannot catch

Each technique has blind spots. Know them before you trust a green build:

| Failure | Replay | Snapshot mock | Schema check |
|---|---|---|---|
| A prompt or model change breaks the agent's path | Catches | Misses (answers mean nothing) | Misses |
| The server removes or renames a tool | Misses (old recording answers) | Misses (old snapshot) | Catches |
| The agent mishandles a tool error | Only if one was recorded | Catches (invalid arguments) | Misses |
| The server returns different data with the same schema | Misses | Misses | Misses |
| Authorization, rate limits, timeouts on the real server | Misses | Misses | Partly (reachability) |
| Side effects of write tools | Misses, by design | Misses, by design | Misses |
| A changed tool description alters model behaviour | Misses | Misses | Lists it, does not judge it |

Three habits close part of the gap:

- **Re-record on purpose.** When a server's behaviour changes, record new runs and review the difference. Never re-record just to turn a red test green.
- **Keep a small live smoke test** that calls the real servers with read-only tools, outside the main suite, so an outage does not block every pull request.
- **Test write tools against a sandbox account**, not through replay. A recording proves the agent asked for a refund; only the real system proves the refund API still accepts it.

## Testing MCP tools in L2M

L2M has all three techniques built in, running on your own deployment. Each is optional: a workflow that calls an MCP server needs no test setup to run.

- **Cassettes.** Turn on **Record MCP calls** in the editor (or send `"record": true` to the execute API) and the run keeps a cassette. Secrets, credential-looking headers and token-shaped strings become `[REDACTED]` before anything is written. **Replay** on the Runs page answers MCP calls from it, `strict` by default, `lenient` when you opt in; model calls are made live ([record and replay](/product/testing-mcp-workflows#record-and-replay)).
- **Snapshot mocks.** The **Snapshot mock server** adapter (`snapshot_mock`) serves a registered server's accepted snapshot inside L2M, and `l2m mcp mock --snapshot <file>` runs the same mock as a <Term id="stdio-transport">stdio</Term> MCP server anywhere Node.js runs. Invalid arguments get an `isError` result; an unknown tool gets a JSON-RPC error ([snapshot mock servers](/product/testing-mcp-workflows#snapshot-mock-servers)).
- **`l2m mcp check`.** Probes registered servers without storing anything, diffs them against their accepted snapshots, and checks <Term id="mcp-tool-policy">tool policy</Term> for every tool a workflow names. Exit code 0 is clean (additive changes are listed), 1 is a breaking change, an unreachable server or a policy-blocked tool (the last two can be allowed with `--allow-unreachable` and `--allow-policy-blocked`), 2 is a usage error. With `--snapshot` it compares a server to a committed snapshot file with no deployment at all ([what counts as a breaking change](/product/mcp-server-registry#what-counts-as-a-breaking-change)).
- **Scheduled probes.** The registry flags the same breaking changes on the server's page. Optionally, **Block runs on breaking change** refuses runs that use the server until an admin accepts the change; it is off by default.

The step-by-step setup, with commands for a CI job, is in [Test MCP servers in CI](/guides/test-mcp-servers-in-ci). To try an MCP agent with no keys and no real server, the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) runs with a built-in echo model and an in-process mock MCP server. Echo never asks for a tool, so that run shows the wiring and the tool list, not a call; attach a tool-calling model to record a cassette worth replaying.

## Further reading

- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): tool definitions, output schemas, the two kinds of error and the list-changed notification
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026): why each trial should start "from a clean environment"
- In L2M: [Testing MCP workflows](/product/testing-mcp-workflows), [Test MCP servers in CI](/guides/test-mcp-servers-in-ci)
