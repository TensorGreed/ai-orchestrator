---
title: "MCP error -32602 Invalid params: arguments rejected"
sidebarTitle: "-32602 Invalid params"
description: "What MCP error -32602 means, why models send tool arguments a JSON Schema rejects or call a tool that does not exist, and how to make calls validate."
level: intermediate
about: tool-calling
related: [tool-calling, mcp-tool, mcp-server, agent-loop, model-context-protocol]
---

# MCP error -32602: Invalid params

`-32602 Invalid params` is the standard JSON-RPC answer for "I understood the method, but not what you passed it". In MCP it almost always comes from `tools/call`: the tool name is unknown, or the arguments the model produced during <Term id="tool-calling">tool calling</Term> do not match the tool's input schema.

## What it means

MCP messages are JSON-RPC 2.0, and JSON-RPC reserves five codes for general failures:

| Code | Message | Meaning |
|---|---|---|
| `-32700` | Parse error | The body is not valid JSON. |
| `-32600` | Invalid Request | The JSON is not a valid request object. |
| `-32601` | Method not found | The method does not exist or is not available. |
| `-32602` | Invalid params | The method's parameters are invalid. |
| `-32603` | Internal error | An internal JSON-RPC error. |

`-32602` is therefore a **protocol error**: the server refused the request before, or instead of, running the tool. The specification for <Term id="mcp-tool">MCP tools</Term> uses it for an unknown tool (its example is `"Unknown tool: invalid_tool_name"`), and lists requests that do not fit the `tools/call` schema as protocol errors too. The same code covers other bad parameters: an invalid pagination cursor, and, since 2026-07-28, a resource URI that does not exist (it used to be `-32002`) and a request missing the required `_meta` fields.

The specification draws a line that matters here. Problems with the request structure are protocol errors. Problems with the *values* the model chose, such as a date in the wrong format or a number out of range, should be **tool execution errors**: a normal result with `isError: true` and a message the model can read and act on. Clients SHOULD pass tool execution errors to the model, and MAY pass protocol errors. In practice some servers answer schema failures with `-32602` anyway, often because their framework checks the arguments against the input schema before the tool's code runs. Either way the cause is the same; what differs is how much of the message the model gets to see.

## Causes (most to least likely)

1. **The arguments do not match the input schema.** A required property is missing, a type is wrong (`"5"` where an integer is expected), a value is outside an `enum`, or there is an extra property and the schema sets `additionalProperties: false`. Nested objects and arrays are where models go wrong most.
2. **The model never saw the full schema.** <Term id="mcp-client">MCP clients</Term> that trim tool definitions to save context drop details such as nested properties, `format`, `pattern`, `minimum` or `oneOf`. The model then guesses, and the server rejects the guess.
3. **The tool name is wrong.** The model invented a name, used the name from an older tool list, or sent a name with a prefix the client added. Clients that combine several servers often rename tools (for example `server__tool`); the server only knows the bare name.
4. **The arguments were not valid JSON.** Some models, especially small or local ones, put the arguments in a code fence, use single quotes or leave a trailing comma. If the client cannot recover an object, it may send `{}` and every required property is missing.
5. **A fixed configuration is wrong.** In a workflow step that calls a tool with arguments from a template, a variable that rendered empty or as a string instead of a number gives the same error every run.
6. **It is not about tool arguments at all.** An invalid `cursor` on `tools/list`, an unknown resource URI, or a 2026-07-28 request without `io.modelcontextprotocol/protocolVersion` in `_meta`. The message usually says which.

If the error names a tool that does not exist, read [MCP server connected but no tools show up](/learn/troubleshooting/mcp-server-shows-no-tools) as well. If the error is `-32601` instead, the method itself is unknown: see [-32601 Method not found](/learn/troubleshooting/json-rpc-32601-method-not-found).

## How to check

**Read the message.** Servers usually name the field: "missing required property", "expected integer", "Unknown tool: ...". That alone often settles it.

**Look at the schema the server publishes.** For a stdio server you can talk to it directly. This uses the dependency-free echo server in the L2M repository (`samples/mcp-echo-server`) and `jq`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"debug","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node samples/mcp-echo-server/server.mjs \
  | jq -c 'select(.id==2) | .result.tools[] | select(.name=="create_ticket") | .inputSchema.required, .inputSchema.properties.priority'
```

```text
["title","reporter"]
{"type":"string","enum":["low","normal","high"]}
```

**Replay the exact call.** Copy the arguments from your client's log or trace and send them yourself. An unknown tool name gives the protocol error straight away:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"debug","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ecko","arguments":{"message":"hi"}}}' \
  | node samples/mcp-echo-server/server.mjs
```

```text
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"l2m-echo","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"Unknown tool: ecko"}}
```

For a remote server, send the same `tools/call` with curl after an `initialize` (see [Session not found](/learn/troubleshooting/mcp-session-not-found-404#how-to-check) for the two-step pattern). If your hand-written call succeeds and the client's fails, diff the two argument objects: the difference is the bug.

**Compare what the model saw with what the server wants.** If the client shows the tool definitions it sends to the model, check that nested properties, enums and formats survived.

## Fix

**Design schemas a model fills in correctly** (server authors):

- Keep arguments flat and few. One level of named properties beats a nested object.
- Use `enum` for closed sets, and put the allowed values and the expected format in the `description` as well ("ISO date, for example 2026-11-16").
- Mark only what you truly need as `required` and apply defaults on the server.
- Accept harmless variations: trim strings, accept `"5"` for an integer, match enum values without regard to case.
- For values that are well-formed but wrong, return a tool execution error with `isError: true` and say how to fix it ("priority must be low, normal or high"). The model can then correct itself on the next turn, which is what the specification intends.

**Give the model the real schema** (client and agent builders): offer fewer tools so each definition can stay complete, pick only the tools a task needs, and test with a model that has reliable tool calling. [Why AI agents fail with too many tools](/learn/agents/too-many-tools) covers the trade-off.

**Fix the name.** Refresh the tool list after a server upgrade, and make sure the client strips any prefix it added before it sends `tools/call`.

**Fix templates.** In fixed workflow steps, check the rendered arguments in the run trace, not the template.

## If you run agents in L2M

- **What the model is shown.** The <Term id="agent-loop">agent loop</Term> trims each tool definition: the first 8 top-level properties, each with its type, a short description, `required` and up to 10 `enum` values; nested properties and array item shapes are dropped. A tool whose important structure is nested is therefore easy for the model to get wrong. See [how the context is kept small](/runtime/agent-loop#how-the-context-is-kept-small).
- **Argument parsing.** For OpenAI, OpenAI-compatible, Azure OpenAI and Ollama models, L2M repairs common syntax problems in the arguments the model returns: code fences, smart or single quotes, unquoted keys, trailing commas, `key=value` pairs. It does not check the result against the schema or fill in missing fields, so it does not prevent `-32602`. When nothing can be recovered, the arguments become `{}`.
- **Missing required arguments are caught first.** Before a call goes out, the runtime checks that every top-level `required` argument is present and not an empty string. If one is missing, the call never reaches the server: the model gets `Tool call '<name>' is missing required arguments: ...` instead of `-32602`. Wrong types, enum values and nested fields are not checked, so those still reach the server.
- **What the agent does with the error.** The server's message reaches the model as the tool result, so it can try again with other arguments. After two failed calls in a row to the same tool in one run, the runtime stops offering that tool and answers further calls with `Tool '<name>' has been disabled due to repeated failures.` If every call in a turn failed, the runtime adds a note asking the model to check tool names and arguments. Repeated rejections are a common way into [an agent stuck calling the same tool](/learn/troubleshooting/agent-stuck-in-tool-loop).
- **Health.** A `-32602` is recorded with the error kind `invalid_arguments`. It means the server answered, so it counts as a success for the [circuit breaker](/product/mcp-server-registry#rate-limits-concurrency-and-the-circuit-breaker) and never pauses the server.
- **Session-based HTTP servers.** L2M sends a failed tool call once more on a new session, because a dead session and other errors look alike from the client side. A `-32602` comes back the same way the second time, and the call then fails.
- **Trying a call by hand.** The [Playground](/product/mcp-onboarding#playground) builds a form from the tool's full input schema, checks required fields and numbers before sending, and shows the JSON-RPC exchange. It is the quickest way to see whether the server or the model is at fault.
- **Through the gateway.** The [MCP gateway](/product/mcp-gateway) answers `-32602` with `Unknown tool: <name>` for a tool name the toolset does not have, and `params.arguments must be an object.` for arguments that are not an object. Gateway tools are named `<server>__<tool>`.

## Further reading

- [JSON-RPC 2.0 Specification, section 5.1: Error object](https://www.jsonrpc.org/specification) (jsonrpc.org)
- [MCP specification, 2026-07-28: Tools, error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Overview, error codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index) (modelcontextprotocol.io)
- In L2M: [Agent loop](/runtime/agent-loop), [MCP Playground](/product/mcp-onboarding#playground), [Two kinds of tool errors](/learn/mcp/tools-resources-prompts#two-kinds-of-errors)
