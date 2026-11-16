---
title: "MCP server connected but no tools show up"
sidebarTitle: "Server shows no tools"
description: "The MCP server starts and connects, yet the agent sees no tools. Check the tools capability, listing errors, pagination, filters, policies and names."
level: intermediate
about: mcp-tool
related: [mcp-tool, mcp-server, mcp-client, mcp-tool-policy, toolset, tool-calling]
---

# MCP server connected but no tools show up

The connection worked, but the tool list that reached the model is empty: the server listed nothing, the listing failed after the connection was made, or the client removed the tools after listing them. Ask the server for its tools by hand first. If it lists them, the cause is on the client side: a selection, an allow-list, a policy or a naming rule.

## What it means

"Connected" and "has tools" are two separate steps in MCP.

1. **The connection.** In the 2025-era protocol, the client sends `initialize` and the server answers with its capabilities. The specification says servers that support tools MUST declare the `tools` capability, and both sides MUST only use capabilities that were negotiated. In the current 2026-07-28 revision there is no `initialize`; a client learns the capabilities from `server/discover` instead. Either way, a successful connection proves only that the server answered.
2. **The listing.** The client then sends `tools/list`. The result can be paginated: the server decides the page size and returns a `nextCursor` while more tools remain, and the client should keep asking until there is none.
3. **The client's own filters.** What the client got from `tools/list` is not necessarily what the model sees. Clients apply selections, allow-lists and policies, and they may rename or drop tools whose names the model provider would reject.

Tools can also change after the connection. A server that declared `listChanged` SHOULD send `notifications/tools/list_changed` when its list changes, and the client lists again. A client that listed too early, or that ignores the notification, keeps showing the old list.

## Causes (most to least likely)

1. **The listing failed and the error was hidden.** `initialize` succeeded, then `tools/list` failed: a missing API key, a timeout, or a server that crashed on its first real request. Some clients show the server as connected and simply list no tools.
2. **The server offers nothing in this configuration.** Many servers decide which tools to register from their arguments or environment: a read-only flag, a list of enabled tool groups, or a token without which they register nothing. The same server can list twenty tools in your terminal and none under the client.
3. **A client-side selection no longer matches.** You picked tools by name earlier, or wrote an allow-list in the config, and a new version of the server renamed them. A name that matches nothing filters everything out, usually without a warning.
4. **A policy hides them.** An admin rule, a read-only mode or a per-role setting in the client removes tools before the model sees the list.
5. **The server forgot the capability.** It answers `tools/list`, but its `initialize` result has no `tools` entry, and a client that follows the negotiation rule never asks.
6. **Names the provider will not accept.** The MCP spec allows letters, digits, `_`, `-` and `.` in tool names, up to 128 characters. Model providers have their own rules (one provider's API, for example, accepts `^[a-zA-Z0-9_-]{1,128}$`, without the dot), so a client must rename such tools or drop them.
7. **Tools arrive late.** The server registers tools after an asynchronous start-up and either does not send `list_changed` or the client does not act on it.
8. **Pagination stops early.** The client reads only the first page, or stops after a fixed number of pages.

A different case looks similar: the tools are listed, but the model never calls them. That is covered in [model won't call tools](/learn/troubleshooting/model-does-not-call-tools).

## How to check

Ask the server directly, in an environment close to the client's. Put the three messages in a file:

```bash
cat > list.jsonl <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
EOF
```

Then start the server with almost no environment, as a desktop client may, and print the capabilities, the tool names and the cursor. This example uses the echo server in the L2M repository; use your server's command and arguments:

```bash
env -i PATH="$PATH" node samples/mcp-echo-server/server.mjs < list.jsonl 2>server.err \
  | jq -c '.result | if .capabilities then {capabilities} else {tools: [.tools[].name], nextCursor} end'
```

```text
{"capabilities":{"tools":{}}}
{"tools":["echo","create_ticket","credentials"],"nextCursor":null}
```

Read the result:

- **No `tools` key in the capabilities**: cause 5. Fix the server.
- **An error instead of a result** (jq stops with `Cannot iterate over null`): run the command without the `jq` step to see the JSON-RPC error, and read `server.err`. Then run it again with the variables the server needs, to see which one it was missing.
- **An empty `tools` array**: cause 2 or 7. Check the server's README for flags or variables that enable tools.
- **A `nextCursor`**: there are more pages. Send `{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"cursor":"<value>"}}` to see them.
- **The tools are there**: the server is fine. The cause is on the client side (3, 4, 6 or 8).

Two more checks help. Any line on stdout that is not JSON can break the stream for a strict client:

```bash
node samples/mcp-echo-server/server.mjs < list.jsonl | grep -v '^{'
```

And names outside the spec's character rule are candidates for being dropped:

```bash
node samples/mcp-echo-server/server.mjs < list.jsonl \
  | jq -r 'select(.id==2) | .result.tools[].name | select(test("^[A-Za-z0-9_.-]{1,128}$") | not)'
```

Both print nothing for a healthy server.

## Fix

- **Hidden listing error**: pass the credential the server needs in the client's server config, not only in your shell, and restart the server. [MCP server can't see API keys](/learn/troubleshooting/mcp-env-vars-not-passed) covers how clients pass the environment.
- **Nothing registered**: add the flag or variable that enables the tool groups you want, as the server's README describes.
- **Stale selection**: list the tools again, then re-select them by their current names.
- **Policy**: ask whoever owns the rules. A hidden tool is usually a decision, not a bug.
- **Missing capability, late tools, bad names**: fix the server. Declare `tools` (with `listChanged: true` if the list can change), register tools before answering the first `tools/list` or send `list_changed` afterwards, and keep names to letters, digits, `_` and `-`.
- **Noise on stdout**: send logs to stderr. Under stdio, the specification says the server MUST NOT write anything to stdout that is not a valid MCP message.

## If you run agents in L2M

An agent lists its servers' tools each time its node starts.

- **A failed listing skips the server, not the run.** If discovery fails for one server, the agent writes `[MCP] Tool discovery failed for server '<adapter>': <error>. Skipping this server.` to the API log and runs with the other servers' tools. So an agent with one MCP server and a missing credential runs with no MCP tools at all. Check the API log. The exception is a server with delegated credentials the user has not connected: that fails the node with a link to connect.
- **The editor shows the error.** Discovering tools on an MCP Tool node returns the server's error, so open the node and list the tools there. For a registered server, the node's tool list comes from the server's last probe: a server marked **Not probed** has none yet, and for one marked **Down** the server page shows the probe's error ([health and status](/product/mcp-server-registry#health-and-status)).
- **Selections filter by name.** With **Single tool only** or **Select multiple tools**, only tools whose names still match are kept. After a server renames a tool, re-select it.
- **Policies hide tools before the model sees them.** A deny rule, or the workflow's **No write tools** switch, removes tools at the start. The agent's output lists them under `_toolPolicy.hidden`, and the Trace tab shows lines such as `calculator hidden by policy Viewers: no calculator`. Discovery in the editor marks these tools instead of hiding them, so builders can see why the agent will not get one ([how it is enforced](/product/mcp-tool-policy#how-it-is-enforced)).
- **What L2M does not drop.** It calls `tools/list` even when a server forgot the `tools` capability, follows `nextCursor` for up to 20 pages, and logs and ignores non-JSON lines on a stdio server's stdout (they appear as `[stdout-non-json]` in the stderr it keeps). Tools with no name are dropped, and so is a tool on a 2026-07-28 HTTP server whose `x-mcp-header` annotation breaks the spec's rules; the API log then names the tool and says it was `left out of the tool list` ([what 2026-07-28 sessions do](/product/mcp-2026-07-28#what-2026-07-28-sessions-do)). Two servers serving one name are both renamed after their server, not dropped ([tool names the model sees](/runtime/agent-loop#tool-names-the-model-sees)).
- **Late tools are picked up.** When a server sends `tools/list_changed` during a run, the registry probes it again a couple of seconds later, so the next run and the node pickers see the new list.
- **Try it by hand.** The [playground](/product/mcp-onboarding#playground) lists a registered server's tools, marks the ones policy blocks for you, and calls them with the JSON-RPC exchange shown.

The [MCP tool discovery returns unexpected tools](/troubleshooting/common-issues#mcp-tool-discovery-returns-unexpected-tools) entry covers the opposite case: tools from a stale endpoint. For an agent that has too many tools rather than none, see [too many tools](/learn/agents/too-many-tools).

Related errors: [MCP error -32000: Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed), [-32601 Method not found](/learn/troubleshooting/json-rpc-32601-method-not-found), [model won't call tools](/learn/troubleshooting/model-does-not-call-tools).

## Further reading

- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): the `tools` capability, `tools/list`, `list_changed` and tool names
- [MCP specification, 2025-11-25: Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) (modelcontextprotocol.io): capability negotiation
- [MCP specification, 2025-11-25: Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination) (modelcontextprotocol.io): cursors and `nextCursor`
- [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) (Anthropic docs): one provider's tool name rule
- In L2M: [MCP tool policy: how it is enforced](/product/mcp-tool-policy#how-it-is-enforced), [Registry health and status](/product/mcp-server-registry#health-and-status), [Playground](/product/mcp-onboarding#playground), [Agent loop: tool names](/runtime/agent-loop#tool-names-the-model-sees)
