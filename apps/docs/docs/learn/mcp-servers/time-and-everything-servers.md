---
title: "Test MCP clients with the time and everything servers"
sidebarTitle: "Time and everything servers"
description: "Use the reference \"everything\" and \"time\" MCP servers to exercise a client: tools, resources, prompts, progress and errors, without credentials."
level: intermediate
related: [mcp-client, mcp-resource, mcp-prompt, elicitation, sampling, structured-tool-output]
---

# Test MCP clients with the time and everything servers

The reference **everything** server exists to test <Term id="mcp-client">MCP clients</Term>: it has a tool, resource or prompt for nearly every protocol feature, including progress notifications, elicitation, sampling, list changes and both error shapes. The reference **time** server is the opposite, three small read-only tools with structured output, which makes it a good first real server. Neither needs an account, a key or a network service, so they are the quickest way to find out what a client actually supports before you connect anything that matters.

## Status of both servers (November 2026)

Both are current reference servers in [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers), not among the servers moved to `servers-archived`. The repository describes its servers as "reference implementations to demonstrate MCP features and SDK usage", "not as production-ready solutions".

| Server | Package | Latest release | Runtime |
|---|---|---|---|
| everything | `@modelcontextprotocol/server-everything` (npm) | 2.3.0, 2026-11-11 | Node.js 24 or later |
| time | `mcp-server-time` (PyPI) | 2026.11.11, 2026-11-11 | Python 3.10 or later, usually through `uvx` |

Both are released often. Pin the version you tested, so a new release does not change your test fixture under you.

## Run them

```bash
# everything: stdio (the default) or Streamable HTTP on http://127.0.0.1:3001/mcp
npx -y @modelcontextprotocol/server-everything@2.3.0 stdio
npx -y @modelcontextprotocol/server-everything@2.3.0 streamableHttp

# time: stdio only, with a fixed default timezone
uvx mcp-server-time==2026.11.11 --local-timezone=UTC
```

The everything server's HTTP mode binds to `127.0.0.1` and accepts only localhost browser origins by default; `HOST=0.0.0.0` exposes it, which you should not need. In a container, the time server cannot see the host timezone, so it reads `LOCAL_TIMEZONE` and falls back to UTC.

## What the everything server exercises

Version 2.3.0 serves two protocol eras from one process. A client that opens with `initialize` gets the 2025-era behaviour; a client that opens with `server/discover` gets MCP 2026-07-28, where capabilities travel with each request. That changes what you see. Opened with `initialize` and an empty capability set, it listed 16 tools, 4 prompts, 8 resources and 4 resource templates. Tools that need a client capability (elicitation, sampling, roots) appear only if the client declared it at `initialize`; on 2026-07-28 they are always listed and a call is refused (`-32021`) when the request does not declare what it needs.

Here is a checklist, one feature per line, with the thing to call:

| Client feature | Call | What a working client shows |
|---|---|---|
| Tool call, input validation | `get-sum` with `{"a": 2, "b": "x"}` | A tool result with `isError: true`: `Input validation error: ... b: Invalid input: expected number, received string` |
| Unknown tool | `tools/call` for `nope` | A JSON-RPC error, code `-32602`, `Tool nope not found` |
| Structured content | `get-structured-content` | `structuredContent` that matches the tool's `outputSchema`, plus the same JSON as text |
| Content types | `get-tiny-image`, `get-annotated-message`, `get-resource-links`, `get-resource-reference` | An image block, content annotations (`priority`, `audience`), `resource_link` items and an embedded `resource` |
| Progress | `trigger-long-running-operation` with `{"duration": 2, "steps": 2}` and a `progressToken` | Two `notifications/progress` (1 of 2, 2 of 2), then the result |
| Cancellation | the same tool with a long duration, then cancel | The server stops its timer and sends no more progress |
| List changes | `trigger-list-changed` with `{"list": "tools"}` | `notifications/tools/list_changed`, and the client lists tools again |
| Resources | `resources/list`, `resources/templates/list`, read `demo://resource/dynamic/text/1` | Text and blob contents; a read of `demo://resource/dynamic/text/abc` fails with `-32602` and the URI in `data` |
| Prompts | `args-prompt` with `city` (required) and `state` | Rendered messages; `completable-prompt` also answers completions |
| Elicitation | `trigger-multi-step-elicitation` | Two questions in a row (a name, then a colour from three choices) |
| Sampling | `trigger-sampling-request` | A request for the client's model, if the client allows it |
| Logging | `trigger-log-messages` | One log message per level at or above the level the client set |

Two tools deserve care even in a test:

- **`get-env`** returns the server's environment as JSON. Values of credential-like names (`*_KEY`, `*_TOKEN`, `*_PASSWORD` and similar) are replaced with `"<redacted>"` unless `GET_ENV_INCLUDE_SECRETS` is set to a true value (`1`, `true`, `yes` or `on`). Leave it unset: with it, secrets go straight into the model's context.
- **`gzip-file-as-resource`** fetches a URL. It is annotated `openWorldHint: true` and is not read-only. The README says it refuses non-public addresses and follows at most five redirects, but that the address check does not catch DNS rebinding. Restrict it with `GZIP_ALLOWED_DOMAINS`, or deny the tool in the client.

## What the time server exercises

The time server has three tools, all annotated read-only, idempotent and closed-world, each with an output schema:

| Tool | Arguments | Returns |
|---|---|---|
| `get_current_time` | `timezone` (optional) | `timezone`, `datetime`, `day_of_week`, `is_dst` |
| `convert_time` | `time` as `HH:MM` (required), `source_timezone`, `target_timezone` | `source`, `target`, `time_difference`, `later_occurrence` |
| `get_time_ago` | `timezone`, `days_ago`, `hours_ago`, `minutes_ago`, `seconds_ago` | the time that far before now |

Converting 16:30 from `America/New_York` to `Asia/Tokyo` on 2026-11-16 returned `"datetime": "2026-11-17T06:30:00+09:00"` and `"time_difference": "+14.0h"`, as structured content and as text. Its errors are tool results, not protocol errors: `"timezone": "europe/warsaw"` returns `isError: true` with `Error executing tool get_current_time: Invalid timezone: 'No time zone found with key europe/warsaw'`, because IANA names are case-sensitive, and `"time": "25:99"` returns `Invalid time format. Expected HH:MM [24-hour format]`. An unknown tool name is a `-32602` JSON-RPC error. It has no prompts or resources; `prompts/list` comes back empty.

That makes it a good agent test. A model that sends `europe/warsaw` should read the error and retry with `Europe/Warsaw`. If your agent instead stops or invents an answer, the problem is in how it handles tool errors, not in the server.

Its answers depend on the clock, so a test that compares results must either use a recording or check the shape (`datetime` is a string with an offset) rather than the value.

## Run them in L2M

L2M is a self-hosted workflow builder and agent runtime, and its MCP client is what you are testing. Register each server under **MCP servers → + Register server** with the `stdio_mcp` adapter:

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything@2.3.0", "stdio"], "timeoutMs": 60000 }
```

```json
{ "command": "uvx", "args": ["mcp-server-time==2026.11.11", "--local-timezone=UTC"], "timeoutMs": 30000 }
```

The sample deployment catalog, `samples/mcp-catalog.example.json`, has an approved time server entry run with `uvx` and pinned to `mcp-server-time==2026.11.11`, the same version as the built-in **Time** preset. With `MCP_CATALOG_ENFORCE=true` a registration must use exactly the pinned package, so when you move to a newer release, update the pin in your catalog to the version you tested ([deployment catalog](/product/mcp-onboarding#deployment-catalog)). Then open **MCP → Playground**: pick a tool, fill in the form generated from its schema and read the **JSON-RPC exchange** panel, which shows the `tools/call` request and the result as L2M received them. The **Resources** and **Prompts** panels read `demo://` resources and render the everything server's prompts ([playground](/product/mcp-onboarding#playground)).

Running the everything server through L2M's stdio client turns the checklist into concrete answers:

- **Era.** With the default protocol mode (`legacy`), L2M opens with `initialize`. It always declares elicitation, so the server adds `trigger-elicitation-request` and `trigger-multi-step-elicitation` to the 16 tools above; workflow runs also declare sampling (and refuse it per server, see below), which adds `trigger-sampling-request`. With `"protocolMode": "auto"` L2M agrees on 2026-07-28 and sees 22 tools, including the task and roots tools ([MCP 2026-07-28 support](/product/mcp-2026-07-28)).
- **Progress.** L2M sends a `progressToken` and receives both progress notifications. In a run they appear on the run tape as tool progress ([progress and cancellation](/product/mcp-server-registry#progress-and-cancellation)).
- **List changes.** `trigger-list-changed` arrives as a list-changed event, and the registry re-probes the server a couple of seconds later.
- **Elicitation.** `trigger-multi-step-elicitation` asks its two questions and completes with `Ada's favorite color is red.` once both are answered. `trigger-elicitation-request` fails: its form includes a multi-select field, and L2M accepts only flat string, number, integer, boolean and enum fields, so it reports `nested schemas are not allowed`. In a run, an attended run shows the questions as a form; unattended runs (webhooks, schedules) decline at once, and the playground declines too ([elicitation](/product/mcp-server-registry#elicitation-a-server-asks-the-person-a-question)).
- **Sampling.** Off by default for every server. Until an admin turns it on for the everything server, `trigger-sampling-request` gets `Sampling is off for MCP server ...` ([sampling](/product/mcp-server-registry#sampling-a-server-asks-the-model-for-a-completion)).
- **Roots.** L2M does not declare the roots capability, so `get-roots-list` is not listed on the 2025-era connection.

None of this needs a model. A workflow with one **MCP Tool** node per tool, each with a fixed `argsTemplate`, walks the checklist on every run.

## Keep it least-privilege

These are test servers, but they still run as processes on the API host. Optionally:

- Deny `get-env` and `gzip-file-as-resource` with [MCP tool policy](/product/mcp-tool-policy) rules on the registered everything server, so no agent sees them.
- Run the everything server in a [container sandbox](/product/mcp-server-registry#sandboxed-stdio-servers) with no network. `gzip-file-as-resource` then cannot fetch anything, and the rest of the checklist still works. Without network `npx` cannot download the package, so use an image built from `src/everything/Dockerfile` in the servers repository, with a version tag (the sandbox refuses `latest`). Its entrypoint is `node dist/index.js` and it reads the first argument as the transport, while L2M appends the registered command and arguments after the image name. Register the command as just `stdio` with no arguments; `npx -y ...` there would reach the server as an unknown transport and stop it.
- Keep sampling off unless you are testing it, and then cap it with **Max tokens per request** and **Max requests per tool call**.

## Record them for CI

Both servers make good fixtures for a client test suite:

1. Turn on **Record MCP calls** and run the checklist workflow once. The <Term id="cassette">cassette</Term> holds every request, result and error.
2. **Replay** the run in `strict` mode after changes. The answers come from the cassette, so the time server's clock stops mattering and neither server has to be installed in CI.
3. Export each server's snapshot. When a new release comes out, run `l2m mcp check --snapshot time.snapshot.json --stdio "uvx mcp-server-time==<new version>"` in CI before you bump the pin, so a release that removes a tool or breaks its arguments fails the build.

[Test MCP servers in CI](/guides/test-mcp-servers-in-ci) has the full commands. For a server of your own that works the same way, see [build a minimal MCP server](/learn/mcp-servers/build-a-minimal-mcp-server).

## Try it in L2M

The quickstart workflow attaches two tools of the built-in mock MCP server, `get_current_time` and `calculator`, to an agent's tool port as **MCP Tool** nodes. Its chat model is the echo provider, which never asks for a tool, so the demo shows the wiring only. The checklist workflow above is shaped differently: there the MCP Tool nodes are steps in the flow itself, each calling its tool with its fixed `argsTemplate`, so no model is involved.

<TryInDemo workflow="wf-mcp-agent-quickstart" />

## Further reading

- [Everything server README](https://github.com/modelcontextprotocol/servers/tree/main/src/everything) and its [feature list](https://github.com/modelcontextprotocol/servers/blob/main/src/everything/docs/features.md) (modelcontextprotocol/servers)
- [Time server README](https://github.com/modelcontextprotocol/servers/tree/main/src/time) (modelcontextprotocol/servers)
- [Tools: error handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling) (MCP specification)
- [MCP tools, resources and prompts](/learn/mcp/tools-resources-prompts)
- [Testing agents that call MCP tools](/learn/testing/testing-mcp-tools)
- [Testing MCP workflows](/product/testing-mcp-workflows)
