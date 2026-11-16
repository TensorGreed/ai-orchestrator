---
title: "MCP elicitation: a server asks the user a question"
term: "Elicitation (MCP)"
topic: mcp
definition: "An MCP server asking the person for input through the client, usually while it handles a request such as a tool call: a message with a simple form, or a URL to open for sensitive steps."
description: "Elicitation lets an MCP server ask the person for input in the middle of a tool call: form mode, URL mode, and how the 2026-07-28 revision reshapes it."
related: [human-in-the-loop, mcp-client, mcp-host, sampling, mcp-tool]
guide: [/learn/mcp/tools-resources-prompts]
---

# Elicitation (MCP)

**An MCP server asking the person for input through the client, usually while it handles a request such as a tool call: a message with a simple form, or a URL to open for sensitive steps.**

Elicitation was added in the 2025-06-18 revision. It reverses the usual direction: instead of the client asking the server, the server sends `elicitation/create` to the client, and the <Term id="mcp-host">host</Term> shows it to a person. A client must declare the `elicitation` capability first; an empty object means form mode only.

The 2025-11-25 revision has two modes:

- **Form mode.** A `message` and a `requestedSchema`: a flat object of string, number, boolean and enum fields (single or multi-select), with no nesting. The answer comes back in `content`. Servers "MUST NOT use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials".
- **URL mode** (new in 2025-11-25). A `url` the person opens in a browser, for steps that "must *not* pass through the MCP client", such as a payment or a third-party sign-in. The client must show the full URL and get consent before opening it.

Every answer has an `action`: `accept` (with data, in form mode), `decline` (an explicit no) or `cancel` (dismissed). The client must make clear which server is asking.

## Example

A booking tool finds two flights and asks:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "elicitation/create",
  "params": { "mode": "form", "message": "Two flights match. Which one?",
    "requestedSchema": { "type": "object",
      "properties": { "flight": { "type": "string", "enum": ["LH400", "UA960"] } },
      "required": ["flight"] } } }
```

The person picks one, the client returns `{ "action": "accept", "content": { "flight": "LH400" } }`, and the tool call continues.

## Common confusion

Elicitation is not an approval step. An approval asks a person whether a call may run at all; elicitation is the server asking for data it needs to finish. It is also not a channel for credentials: those belong in configuration or, if they must come from the person, in URL mode.

In 2026-07-28 the server no longer sends its own request. It answers the original `tools/call`, `resources/read` or `prompts/get` with an `input_required` result, and the client retries with the answers (the Multi Round-Trip Requests pattern). URL mode's completion notification is removed. Elicitation itself is not deprecated.

## In L2M

L2M declares form-mode elicitation to every server, not URL mode, and accepts single-value fields only: a multi-select (array) field is refused. In attended runs (started from the editor, Chat, a retry or a resumed approval) the form appears in Chat and under **Waiting for you** on the Runs page. Unattended runs (webhooks, schedules, queue workers, the gateway, the public chat widget) decline at once, and a form with credential-like field names is refused whatever the trigger. Unanswered requests expire after `MCP_ELICITATION_TIMEOUT_MS`, 10 minutes by default ([elicitation](/product/mcp-server-registry#elicitation-a-server-asks-the-person-a-question)). For 2026-07-28 servers, L2M answers `input_required` with the same handlers ([MCP 2026-07-28 support](/product/mcp-2026-07-28#what-2026-07-28-sessions-do)).

## Further reading

- [MCP specification 2025-11-25: elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) (modelcontextprotocol.io)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
