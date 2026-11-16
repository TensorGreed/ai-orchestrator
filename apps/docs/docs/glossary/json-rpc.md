---
title: "JSON-RPC 2.0 in MCP: requests, responses, errors"
term: "JSON-RPC"
topic: mcp
definition: "A small message format for remote calls: a request names a method and carries an id, the response echoes that id with a result or a numbered error, and a notification has no id and gets no answer."
description: "JSON-RPC 2.0 is the message format MCP uses: requests with ids, notifications without, and numbered errors such as -32602. A plain explanation."
related: [model-context-protocol, mcp-client, mcp-server, stdio-transport, streamable-http, structured-tool-output]
guide: [/learn/mcp/transports]
---

# JSON-RPC

**A small message format for remote calls: a request names a method and carries an id, the response echoes that id with a result or a numbered error, and a notification has no id and gets no answer.**

Every message between an <Term id="mcp-client">MCP client</Term> and an <Term id="mcp-server">MCP server</Term> is a JSON-RPC 2.0 object, whether it travels over <Term id="stdio-transport">stdio</Term> or <Term id="streamable-http">Streamable HTTP</Term>. There are three kinds:

- **Request**: `jsonrpc`, `method`, optional `params` and an `id`. MCP is stricter than plain JSON-RPC here: the id must be a string or an integer, never `null`, and must not repeat an id still waiting for an answer.
- **Response**: the same `id`, plus either `result` or `error`, never both.
- **Notification**: a request without an `id`. The receiver must not reply, so the sender never learns whether it failed.

The id is what lets many calls share one connection: answers can come back in any order and still be matched.

## Error codes

JSON-RPC reserves -32768 to -32000 for predefined errors:

| Code | Name | Meaning |
|---|---|---|
| -32700 | Parse error | The body is not valid JSON. |
| -32600 | Invalid Request | Valid JSON, but not a valid request object. |
| -32601 | Method not found | The method does not exist or is not available. |
| -32602 | Invalid params | The parameters are wrong. |
| -32603 | Internal error | Internal JSON-RPC error. |
| -32000 to -32099 | Server error | Left to implementations. |

MCP 2026-07-28 splits that server range: -32020 to -32099 is reserved for codes the MCP specification defines (such as -32022, unsupported protocol version), and -32000 to -32019 is legacy, where receivers must not assume a meaning, except -32002 (resource not found in older revisions).

## Example

```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_weathr","arguments":{}}}
{"jsonrpc":"2.0","id":7,"error":{"code":-32602,"message":"Unknown tool: get_weathr"}}
{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}
```

## Common confusion

A JSON-RPC error is not the same as a failed tool. MCP reports a tool that ran and failed (an API down, a date in the wrong format) as a normal result with `isError: true`, which the model can read and correct. Protocol errors such as -32602 mean the request itself was wrong. Batches (an array of requests) are part of JSON-RPC, but MCP removed them in the 2025-06-18 revision.

## In L2M

As a client, L2M answers requests a server sends it: `ping`, `elicitation/create` and `sampling/createMessage`, with -32602 for malformed ones and -32601 for any other method. The [MCP gateway](/product/mcp-gateway#the-endpoint) answers bad JSON with -32700, malformed messages with -32600, and accepts batches only on 2025-03-26. With the opt-in [2026-07-28 mode](/product/mcp-2026-07-28#the-mcp-gateway), mismatched headers get -32020 and unsupported versions -32022.

## Further reading

- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification) (jsonrpc.org)
- [MCP specification 2026-07-28: base protocol, messages and error codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index) (modelcontextprotocol.io)
- [MCP specification 2025-11-25: tools, error handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP 2025-06-18 changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog) (modelcontextprotocol.io)
