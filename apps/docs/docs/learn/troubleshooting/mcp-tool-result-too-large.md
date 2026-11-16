---
title: "MCP tool result too large: token limits and fixes"
sidebarTitle: "Tool result too large"
description: "Why an MCP tool response exceeds the allowed tokens or fills the context window, and how to fix it on the server, in the client and in the agent."
level: intermediate
about: mcp-tool
related: [mcp-tool, context-window, token-llm, structured-tool-output, session-tool-cache, mcp-resource]
---

# MCP tool result too large: token limits and fixes

A tool sent back more text than the client, or the model behind it, will take in one tool result. The lasting fix is at the source: make the tool return less, with filters, a page size, a summary or a link to the full data. Then set a limit in the client, so that an oversized result is trimmed instead of failing the run.

## What it means

When a model calls an <Term id="mcp-tool">MCP tool</Term>, the server's answer travels three steps: from the server to the client as a `tools/call` result, then from the client into the conversation as a tool message, then to the model on its next request. The MCP specification puts no size limit on a tool result. The limits come from the two later steps.

- **The client.** Some clients cap a single tool result at a fixed number of <Term id="token-llm">tokens</Term>. Over the cap, they refuse the result with an error such as "tool response exceeds maximum allowed tokens", or they cut it. The wording and the number differ from client to client, and some let you raise the cap in their settings.
- **The model.** Every tool result becomes part of the conversation, and the conversation shares the model's <Term id="context-window">context window</Term> with the system prompt and the tool definitions. An agent sends the whole conversation again on every iteration of its loop, so a 30,000-token result is paid for on every later model call in that run, not once.

So "too large" can mean two different failures: the client refused one result, or the run as a whole outgrew the context window. The first names the tool; the second usually shows up as a context-length error from the model provider.

## Causes (most to least likely)

1. **The tool returns everything it found.** A list or search tool with no `limit` argument returns every issue, row or file. A query without a `LIMIT`, or a "read file" tool on a log file, does the same.
2. **The format is heavy.** Raw HTML instead of text, pretty-printed JSON, every field of every record when the model needs three, or images and other binary data inline as base64.
3. **The same data is sent twice.** The spec lets a tool return `structuredContent` and says it SHOULD also return the serialized JSON in a text block. When the text block is a different, longer rendering instead, a client that passes both on to the model sends the data twice.
4. **There is no way to ask for less.** MCP's pagination utility covers list methods such as `tools/list` and `resources/list`, not the result of a tool call. A tool that never defined its own cursor or page arguments cannot be asked for page two.
5. **Many medium results add up.** No single result is over any cap, but ten of them in one run fill the context window. That is a context-length problem, covered in [context-length overflow](/troubleshooting/common-issues#context-length-token-overflow).
6. **The client's cap is lower than the task needs.** Sometimes the result really must be large, and the limit is the thing to change.

## How to check

Call the tool outside the agent and measure what comes back. For a stdio server, pipe an `initialize` request, the `initialized` notification and the call into it. This uses the dependency-free echo server in the L2M repository; replace the command with your server's own, and the tool name and arguments with the call that failed:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_ticket","arguments":{"title":"Printer jam","reporter":{"name":"Sam"}}}}' \
  | node samples/mcp-echo-server/server.mjs \
  | jq -c 'select(.id==2) | .result | {blocks: [.content[].type], structured: (.structuredContent != null), chars: (tostring | length)}'
```

```text
{"blocks":["text"],"structured":true,"chars":198}
```

The output tells you three things: which content block types came back (many `text` blocks, `image` blocks or embedded `resource` blocks are the usual suspects), whether there is structured content next to the text, and the size of the result in characters. Run it again with a narrower argument, such as a smaller date range, to see whether the tool can return less at all.

For a remote server, a client with an inspector or a tool playground gives you the same view. Look at the arguments the model sent as well as the result: often the model asked for "all issues" because nothing told it to filter.

## Fix

**If you own the server**, make the result small by design:

- Give list and search tools a `limit` argument with a small default and a hard maximum, and a filter for the fields the caller needs.
- Paginate inside the tool. Return a cursor in the result and accept it as an argument, so the model can ask for the next page only when it needs it:

  ```json
  {
    "name": "list_issues",
    "description": "List open issues, newest first. Returns at most `limit` issues and a `next_cursor` when there are more.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 },
        "cursor": { "type": "string", "description": "next_cursor from the previous call" }
      }
    }
  }
  ```

- Return a `resource_link` for large content instead of inlining it. The spec lets a tool return a URI the client can fetch with `resources/read` when, and if, it needs the content. Check that your clients can follow links before relying on this.
- Summarise on the server: counts, the top results and the identifiers the model needs for a follow-up call, rather than raw records.
- Convert HTML to text, drop pretty-printing, and leave out fields no caller uses.
- If you return `structuredContent`, make the text block its serialized JSON, as the spec suggests, not a second, longer rendering.

**If you do not own the server**:

- Steer the model to the narrow call. Say in the system prompt which arguments to use ("always pass `limit: 10`; search by issue key when you have one"), and select only the tools the task needs.
- Raise the client's cap only when the result is really needed in full. Raising it moves the problem to the context window.
- Put a small wrapper in front of the tool that calls it, trims the result and returns the trimmed version. A workflow served as a tool can do this.

## If you run agents in L2M

An L2M agent does not fail a run because a tool result is long. It trims the tool message before the model sees it, using limits set on the Agent node:

| Field on the Agent node | A new node starts at |
|---|---|
| Tool Message Max Chars | 6,000 |
| Tool String Max Chars | 400 |
| Tool Array Max Items | 8 |
| Tool Object Max Keys | 32 |
| Tool Payload Max Depth | 4 |

A result that fits in Tool Message Max Chars reaches the model unchanged. A longer one is compacted: strings are cut and end in `...[truncated N chars]`, arrays keep their first items and gain `{"_truncatedItems": N}`, objects keep their first keys and gain `_truncatedKeys`, and deeper nesting becomes a short note. The message is marked `"_meta": {"truncated": true, "originalChars": ...}`. If it is still too long, the model gets only the first part of the raw JSON as a `preview`. Tool Message Max Chars cannot go below 500.

Trimming keeps a run alive, but the model can then answer from a partial list. Tell it in the system prompt that a result marked truncated is incomplete and that it should narrow the call. See [how the context is kept small](/runtime/agent-loop#how-the-context-is-kept-small) for every limit the runtime applies.

- **The full output is kept.** When the run has a `session_id`, the runtime stores each tool call's full arguments and output in the <Term id="session-tool-cache">session tool cache</Term>, outside the prompt. The model gets two extra tools: `session_cache_list` and `session_cache_get`, which takes an `output_path` such as `items[40].title` to fetch one part of a stored result. See the [session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse).
- **Structured results are not doubled when they agree.** When a tool's text block is just its structured result serialized, the model gets the object once. When the text says something else, the model gets both, as `{ "content": ..., "structuredContent": ... }`, so a tool that sends two different renderings costs twice ([structured output](/product/mcp-server-registry#structured-output)).
- **Resource links are not followed.** L2M gives the model no tool for reading resources. A workflow reads one with an MCP Tool node set to **Read a resource**, capped at 5 MiB by default by `MCP_RESOURCE_MAX_BYTES`. A larger one fails the read with `Resource '<uri>' is larger than the 5 MiB read limit.`
- **Fewer tools leave more room.** Tool definitions share the same context. [Too many tools](/learn/agents/too-many-tools) covers keeping that list short.

Related errors: [model won't call tools](/learn/troubleshooting/model-does-not-call-tools), [agent stuck in a tool loop](/learn/troubleshooting/agent-stuck-in-tool-loop) (a truncated result the model keeps asking for again is one cause), and [-32602 Invalid params](/learn/troubleshooting/json-rpc-32602-invalid-params) for a model that sends a `limit` the schema rejects.

## Further reading

- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): tool results, resource links and structured content
- [MCP specification, 2025-11-25: Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination) (modelcontextprotocol.io): cursors for list methods
- [Define tools: best practices](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) (Anthropic docs): "Design tool responses to return only high-signal information"
- In L2M: [Agent loop: how the context is kept small](/runtime/agent-loop#how-the-context-is-kept-small), [Session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse), [Structured output](/product/mcp-server-registry#structured-output), [Common issues: context-length overflow](/troubleshooting/common-issues#context-length-token-overflow)
