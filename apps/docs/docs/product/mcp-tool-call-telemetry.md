---
description: "What L2M records for every MCP tool call: timings, errors, tokens and a safe argument summary that never keeps free text or personal data. How to switch it off."
---

# MCP tool-call telemetry

L2M records one telemetry row for every MCP tool call: calls a workflow makes (agent tool calls and MCP Tool nodes), calls MCP clients send through the [gateway](./mcp-gateway.md) and calls a builder makes from the playground. The [control plane](./mcp-control-plane.md) builds its call counts, error rates, latency, cost and recent calls from these rows.

## What a row holds

- the server, tool, node, workflow and execution the call belongs to, and where it came from (`workflow`, `gateway` or `playground`, plus the client for gateway calls);
- when it started, how long it took, whether it failed (the error text is redacted and cut to 500 characters) and why it was refused, if the runtime refused it;
- the model tokens and cost of the turn that asked for it, and any sampling the server requested;
- a **safe summary of the call's arguments**;
- the **role** and **subject source** the call ran under (`user`, `owner`, `fallback` or `client`, as in the [tool policy](./mcp-tool-policy.md)) and the **project**.

The argument summary, role and project are what lets L2M later suggest and test tool rules from real runs without keeping the arguments themselves.

## The argument summary

The summary describes each argument by its path (`state`, `labels[]`, `files[].path`). For each path it keeps:

| The argument holds | The summary keeps |
| --- | --- |
| A number, a boolean or null | The value, with the smallest and largest seen. An integer of nine or more digits keeps only its type. |
| A short, single-word value such as `open`, `main`, `us-east-1` | The value. A value listed in the tool's input schema (`enum` or `const`) is kept too. |
| A repository such as `octo-org/hello-world` | The owner: `octo-org/`. |
| A URL | Its scheme and host: `https://api.github.com`. Never the path, query or credentials. |
| A file path | Its first two segments: `/srv/data/`. Never the whole path. |
| An email address | Its domain: `@example.com`, with the data class `email`. |
| Free text, long or random-looking values (ids, hashes, tokens) | Only the type and a length bucket (`1-8`, `9-32`, `33-128`, ...). |
| Anything the data detectors flag: card numbers, IBANs, national ids, phone numbers, keys, tokens, private keys | Only the data class, such as `card_number` or `credential`. |

A few more rules keep the summary safe:

- The values are scanned with the same detectors as [production capture](./production-capture.md) masking, including URL-encoded and JSON-escaped forms. Object keys are scanned too; a key that is data (an email used as a key, for example) is written `*`.
- A string under a credential-like key (`token`, `password`, `api_key`, `secret`, ...) is kept only as `credential`.
- A string under a key that usually holds people's words or names (`query`, `message`, `body`, `title`, `to`, `assignee`, `author`, ...) is never kept as a value, even when it is one short word.
- Large or deeply nested arguments are summarised up to fixed limits (depth, paths, array items, characters scanned); a value that could not be scanned within them is never kept as a value. The summary is then marked `truncated`.

For example, the arguments

```json
{ "owner": "octo-org", "repo": "octo-org/hello-world", "state": "open", "per_page": 50,
  "title": "Crash when saving", "body": "Card 4111 1111 1111 1111 was charged twice" }
```

are summarised as

```json
{ "v": 1, "fields": {
  "body": { "type": "string", "classes": ["card_number"], "len": "33-128" },
  "owner": { "type": "string", "values": ["octo-org"] },
  "per_page": { "type": "number", "values": [50], "min": 50, "max": 50 },
  "repo": { "type": "string", "prefixes": ["octo-org/"] },
  "state": { "type": "string", "values": ["open"] },
  "title": { "type": "string", "len": "9-32" } } }
```

Summaries are not a substitute for masking: a single word an agent passes as a plain value (a first name in a field called `name`, for example) can be kept. If your tools take personal data in such fields, switch summaries off.

## Who can see it

Admins see each recent call's summary and role in the tool drawer of **MCP → Tools** (`GET /api/mcp/tools`, `recentCalls[].argsSummary`); builders see the calls without them. Audit bundles of a run include its telemetry rows, summaries included.

## Retention

Telemetry rows, summaries included, are pruned with execution history (`EXECUTION_HISTORY_RETENTION_DAYS`, default 30 days) and deleted with their run.

## Switching it off

Argument summaries are on by default and need no setting. To stop recording them, set

```bash
MCP_TOOL_ARGUMENT_SUMMARIES=false
```

and restart the API. New rows then keep no summary, role, subject source or project; everything else is recorded as before. Rows written earlier keep their summaries until retention removes them.
