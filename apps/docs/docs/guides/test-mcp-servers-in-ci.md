---
title: "Test MCP servers in CI: cassettes, snapshot mocks and breaking changes"
description: "Make MCP-dependent agents testable: record MCP calls as cassettes, run a snapshot mock server, and fail CI on breaking schema changes with l2m mcp check."
---

# Test MCP servers in CI

Agents that call MCP servers are hard to test: servers change their tool schemas, go down, and return different answers from one run to the next. A test that passed yesterday can fail today because a server renamed a parameter, and nobody hears about it until a run breaks in production.

Three techniques fix that, and L2M has all three built in, running on your own deployment:

- **Record and replay**: capture every MCP call a run makes as a *cassette*, then run the workflow again with the calls answered from it.
- **Snapshot mocks**: a stub MCP server generated from a server's accepted tool schemas, for offline tests.
- **A schema gate in CI**: `l2m mcp check` fails the build when a server has a breaking change, cannot be reached, or a workflow depends on a tool that policy blocks.

## 1. Record a cassette

In the editor, open the **⋯** menu and turn on **Record MCP calls**, then run the workflow. The Run button shows a red dot while recording is on. Through the API, send `"record": true` to `POST /api/workflows/:id/execute`.

The run gets a cassette badge on the **Runs** page. Open it to see every MCP call in order with its arguments, result and timing. Secrets, credential-looking headers, token-shaped strings and sensitive elicitation answers are replaced with `[REDACTED]` before anything is written.

**Download** saves the cassette file; you will use it with the mock below.

## 2. Replay against the cassette

**Replay** on the Runs page runs the execution again with the same input and the workflow as it is now, answering MCP calls from the cassette:

- `strict` (default): a call the cassette has no answer for fails the run, and the result lists every miss. Strict replay never contacts an MCP server.
- `lenient`: calls the cassette never saw go to the live server and are counted.

That makes replay a regression test after you edit a prompt or a workflow. Model calls are made live in this replay, so use a deterministic model setting, or move to golden runs with a model tape ([CI for AI agents](./ci-for-ai-agents.md)).

## 3. Run a snapshot mock

Every probed server has an **accepted snapshot**: the tool schemas you last accepted. Export it and serve it as a stdio MCP server anywhere Node.js runs, with no network access:

```bash
export L2M_API_URL=https://l2m.example.com
export L2M_API_KEY=l2m_…                 # a builder API key

pnpm l2m mcp snapshot export --server mcp_123 --out docs-server.snapshot.json
pnpm l2m mcp mock --snapshot docs-server.snapshot.json --cassette run.cassette.json
```

The mock checks arguments against each tool's input schema, then answers from the cassette when it has a matching call, then from an example built from the tool's output schema, then with a fixed text. Inside L2M, the **Snapshot mock server** adapter (`snapshot_mock`) does the same, so you can point a copy of a workflow at it and demo or test it offline.

Commit the snapshot file next to your workflows: it is also what the offline check below compares against.

## 4. Fail the build on breaking changes

`l2m mcp check` lives in `packages/cli`; from a checkout run it with `pnpm l2m`. Against your deployment it probes each server without storing anything, diffs its tools against the accepted snapshot, and evaluates tool policy for every tool a workflow names:

```bash
pnpm l2m mcp check                        # every registered server
pnpm l2m mcp check --server mcp_1,mcp_2   # some servers
pnpm l2m mcp check --toolset support      # a toolset's servers and the servers its workflows use
pnpm l2m mcp check --workflow wf_1 --json
```

Without a deployment, compare a server with a committed snapshot file:

```bash
pnpm l2m mcp check --snapshot docs.snapshot.json --stdio "npx -y docs-mcp-server@1.4.0"
pnpm l2m mcp check --snapshot docs.snapshot.json --url https://mcp.internal.example/mcp
pnpm l2m mcp check --snapshot docs.snapshot.json --against docs.next.snapshot.json
```

Offline checks cover breaking changes and reachability; tool policy needs the API.

A CI job needs only `L2M_API_URL` and `L2M_API_KEY` from its secret store, and the exit code:

```bash
pnpm install --frozen-lockfile
pnpm l2m mcp check --json > mcp-check.json   # the job fails when this exits non-zero
```

| Exit code | Meaning |
| --- | --- |
| 0 | Clean. Additive changes are listed but do not fail the check. |
| 1 | A breaking change, an unreachable server (unless `--allow-unreachable`), a policy-blocked tool (unless `--allow-policy-blocked`), or the API refused the request or could not be reached. |
| 2 | Usage error: unknown command, missing flag or unreadable file. |

## How it works

- **What counts as breaking.** A removed tool, a removed input property, a narrowed or changed type, a new required property, or an enum that loses a value. Adding tools or optional properties, changing descriptions and changing annotations are compatible. Output schemas are compared with the rules reversed. The full table is in [the registry docs](../product/mcp-server-registry.md#what-counts-as-a-breaking-change).
- **In the registry too.** Scheduled probes flag the same breaking changes on the server page, and with **Block runs on breaking change** on, runs that use the server are refused until an admin presses **Accept change**.
- **Matching.** A replayed call matches a recorded one by server, method, tool name and a hash of its canonical arguments. Repeated identical calls get their answers in recorded order.

## What it does not do

- A cassette replay on the Runs page calls your model again, so an agent can take a different path than when it was recorded.
- Recordings go stale: a cassette answers only what was recorded, so re-record when a server's behaviour changes.
- Cassettes are capped (`MCP_CASSETTE_MAX_BYTES`, `MCP_CASSETTE_MAX_CALLS`); calls past the cap are not kept and the cassette is marked truncated.

## Next steps

- Reference: [Testing MCP workflows](../product/testing-mcp-workflows.md), [MCP server registry](../product/mcp-server-registry.md)
- Guides: [CI for AI agents](./ci-for-ai-agents.md), [Govern MCP tools](./govern-mcp-tools.md)
- Try it with no keys: [build your first MCP agent](../getting-started/build-your-first-mcp-agent.md) uses an in-process mock MCP server
