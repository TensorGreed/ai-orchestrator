---
title: "AI gateway: OpenAI-compatible /v1 endpoint for apps"
description: "The /v1 AI gateway: an OpenAI-compatible endpoint for apps outside L2M, with per-client tokens, content rules, budgets, rate limits and streaming."
---

# /v1 AI gateway

L2M serves an OpenAI-compatible API at `/v1`, so applications outside L2M can send their model traffic through the same rule sets, budgets, rate limits and audit as workflows and the [MCP gateway](./mcp-gateway). Any OpenAI SDK or HTTP client works: point its base URL at `https://<your-l2m>/v1` and use an L2M client token as the API key.

```text
app ──Bearer client token──▶ POST /v1/chat/completions  { model: "fast-chat", ... }
                               ├─ token, grant, rate limit, budgets, model allowlist
                               ├─ Content rules on the prompt
                               ├─ provider (the route's provider, model and stored key)
                               ├─ Content rules on the answer
                               └─ usage row (tokens, cost, latency; never prompts or answers)
```

The gateway is optional and off until you set it up: with no route set, every `/v1` call answers `401` or `404` and nothing else changes.

## Route sets and routes

A **route** maps a public model name to a provider. Callers send that name as `model`; they never name a provider or an upstream model themselves.

| Field | Meaning |
| --- | --- |
| Model name (`alias`) | What callers send as `model`, for example `fast-chat`. Unique across the deployment. |
| Kind | `chat` (for `/v1/chat/completions`) or `embedding` (for `/v1/embeddings`). |
| Provider | A chat provider (`openai`, `azure_openai`, `openai_compatible`, `anthropic`, `gemini`, `ollama`), or for embeddings one of `openai`, `azure_openai`, `openai_compatible`, `ollama`. |
| Upstream model | The provider's model. For Azure OpenAI, the deployment name. |
| Base URL | Optional; the provider's default otherwise. |
| API key | A stored secret, by reference. The key is never shown or returned; without one the provider's environment key applies. |
| Defaults | Optional temperature, max tokens and top_p, used when a request leaves them out. |

Routes are grouped in **route sets**. A route set belongs to a project: the project's budgets count its requests, its routes may use the project's secrets, and its project-enforced rule set applies. A route set can also carry a rule set and a default rate limit of its own.

Admins manage route sets under **MCP → AI routes**, and see their usage there. Builders see the route sets and routes, read only; usage is spend across every project, so it stays with admins, as on the Usage pages.

## Clients

Callers authenticate with the same client tokens as the MCP gateway. Create a client under **MCP → Clients** (it needs no toolset if it only calls `/v1`), then open its **Governance** and tick the route sets it may call under **AI routes**. A client sees only the models of the route sets granted to it; any other model name answers `404 model_not_found`, the same as an unknown one.

A client's rule set, rate limit and budgets apply to its `/v1` calls as well as to its MCP calls. Its own rate limit is one allowance for both.

## Calling the gateway

With curl:

```bash
curl https://l2m.example.com/v1/chat/completions \
  -H "Authorization: Bearer $L2M_CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "fast-chat", "messages": [{"role": "user", "content": "Summarise our refund policy in one line."}]}'
```

With the OpenAI SDK for Python:

```python
import os

from openai import OpenAI

client = OpenAI(base_url="https://l2m.example.com/v1", api_key=os.environ["L2M_CLIENT_TOKEN"])
answer = client.chat.completions.create(
    model="fast-chat",
    messages=[{"role": "user", "content": "Summarise our refund policy in one line."}],
)
print(answer.choices[0].message.content)
```

With the OpenAI SDK for JavaScript:

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://l2m.example.com/v1", apiKey: process.env.L2M_CLIENT_TOKEN });
const vectors = await client.embeddings.create({ model: "embed-small", input: ["first text", "second text"] });
```

`GET /v1/models` lists the client's models. Tools are passed through: send `tools` and `tool_choice`, and the model's tool calls come back as `tool_calls` for your application to run. Images must be base64 data URLs; the gateway never fetches a URL. A parameter the route's provider cannot honour (for example `seed` on Anthropic) answers `400` rather than being dropped.

## Streaming

`"stream": true` streams for real: chunks are `chat.completion.chunk` objects in `data:` frames, comment heartbeats keep idle connections open, and the stream ends with `data: [DONE]`. With `"stream_options": {"include_usage": true}` the last chunk before `[DONE]` carries the token usage. If the caller disconnects, the provider call is cancelled.

If the provider fails during a stream, by sending an error or by ending with no finish reason, `[DONE]` or usage frame, the stream ends with an error event with code `upstream_error`, then `[DONE]`, and no `finish_reason`, so a caller can tell a cut-off answer from a complete one. The usage row says `upstream_error`. A server that ends a stream with none of those three signs looks the same as a dropped connection, so it is reported as a failure too.

A provider without streaming answers in one piece, sent as a stream of the same shape.

## Content rules

A route set's rule set, the client's, the project's enforced rule set and the deployment's destination rules check each request. The project's enforced rule set and the destination rules apply on their own too, with nothing bound to the route set or the client. (Before this release, both applied only once a rule set was bound there; set `GATEWAY_RULES_WITHOUT_BINDING=false` to keep that.) The instance default rule set (`GUARD_AUTO_APPLY`) never applies to `/v1`: with none of these, requests are not checked.


- **Prompt.** The request before it goes to the provider, as described below. Tool results the caller sends back (`tool` messages) are checked as outside content. The deployment's destination rules apply to the route's provider. A blocked prompt answers `400` with code `content_filter`, and the provider is never called.
- **Answer.** The answer's text and the arguments of any tool calls, on the `final_output` channel. `/v1` has no separate `model_output` check: the answer is what the caller receives. A blocked answer has `finish_reason: "content_filter"`.

On the way in, rule sets read the text the request sends to the provider: message text, tool results (labelled as outside content), the arguments of earlier tool calls, tool names, descriptions and schemas, `response_format`, `stop` and `user`, and for embeddings the inputs and `user`. A rewrite is applied in place. Restricted text in a name or key the rest of the request depends on, such as a tool name or a schema property, blocks the request instead. Images are not read: the gateway takes images only as data URLs, and a rule set does not see what an image contains. Numeric fields (`seed`, `max_tokens` and the like) are not read either.

If your application puts outside text into a `user` message, such as passages from its own search, mark the message with `"l2m": {"untrusted": true}`. Its text is then checked as outside content, like a tool result, so rules for planted instructions apply to it. The mark is never sent to the provider.

In a conversation, each request carries the earlier turns again. Text that passed every rule cleanly (nothing found, nothing changed) is remembered for ten minutes, per client, so the next request checks only what is new and records rule events only for that. The gateway keeps no text for this, only a hash, and each instance remembers only what it checked itself. It is not used when destination rules apply to the request, and not for a rule set with the injection classifier, which scores the whole conversation together.

When streaming, a rule set that checks the answer but does not rewrite it (only blocks) lets the text through as it is checked. New text is checked at sentence boundaries and every few hundred characters, with the end of what was already sent in front of it for context. Text that passed is released except for its last 256 characters, and further back when that point falls inside an unbroken value such as an address, a key or a URL, so a match still arriving is not sent in part. The tail goes out after the last check of the whole answer. A block cuts the stream: the last chunk has `finish_reason: "content_filter"`, an error event with code `content_filter` follows, then `[DONE]`. Review and approval actions block, because nobody waits on an API call.

A rule set that rewrites the answer (redact, mask, protect, or the hidden-character transform on `final_output`) has the whole answer generated and checked before any of it is sent, as before. The built-in rule set and copies of it work this way. To stream with rewrites instead, set `"stream": "window"` on each of those rules: each part is then rewritten as it is released, and a value that runs past the release point waits for the next one, so it is never sent in two pieces. Windowed rewrites apply only when it is safe; the answer is buffered anyway when:

- any rewrite rule on `final_output` lacks `"stream": "window"`, or the default action rewrites;
- a rule protects values (a vault token per part would not match the token recorded for the answer);
- a rewrite rule can apply to a finding that grows past the held-back tail: a private key block (its lines arrive one at a time), or a score over the whole answer, such as the injection classifier's. Block key blocks instead (`"private_key": {"action": "block"}`) to stream;
- a detector on `final_output` is not one the gateway knows.

`"stream": "buffer"` on any `final_output` rule always buffers.

[Output checks](./content-rules-output-checks.md) that judge a complete answer (answer schema, grounding) are skipped by the checks at each boundary and run in the check of the whole answer. When one of them would block (not in shadow, not `allow`), the answer is buffered, so the block can stop it before anything is sent. Topic and safety checks run at each boundary like any other detector. Each boundary check reads only the newest part of the answer, so a topic allow list can flag any part that names no allowed topic and cut the stream. Set `"stream": "buffer"` on the `off_topic` rule so the whole answer is judged once.

Output checks set to call a model (safety by model, topics by meaning, the grounding judge) do not run on `/v1`. A rule set with one cannot be bound to a route set or a client: the binding, or a save that adds such a check to a bound rule set, answers `400`. A project's enforced rule set is not refused; on `/v1` such a check cannot run, and the rule set's failure policy decides (`fail_closed`, the default, blocks every answer).

With windowed rewrites, the held-back tail has limits. Text that was released cannot be recalled. If a value to rewrite turns out to have started in text already sent, the stream is cut rather than rewriting only the rest. If the check of the whole answer rewrites a value that went out unchanged, the stream ends with `content_filter` and the request is recorded as blocked, never as rewritten. So part of a match can reach the caller, followed by a cut, when:

- a match with spaces in it is longer than the tail, such as a long custom phrase;
- an unbroken value runs past 4096 characters;
- a rule only fires on what comes later, such as a phrase that makes earlier text sensitive.

If the caller leaves or the provider fails part way, the parts already rewritten are still recorded as rule events.

Send the output limit as `max_tokens` or `max_completion_tokens`. On an `openai` route the name you use is the name sent; other providers get `max_tokens`. With `stream_options: {"include_usage": true}` the final usage chunk carries the provider's own numbers; a provider that sent none gets no usage chunk (the usage row still carries an estimate).

Browser apps can call `/v1` from an origin in `MCP_GATEWAY_ALLOWED_ORIGINS` (or `WEB_ORIGIN`). The preflight accepts the extra headers the OpenAI browser SDK sends, and `Retry-After` is readable by the page. Keep the token out of public pages: anyone who can read it can use the route.

Verdicts are recorded on the Security page with placement `gateway`, the request's `aigw_` id and the model name.

## Budgets and rate limits

Every request that reaches the provider writes a usage row (tokens, estimated cost, latency, model, finish reason, rule outcome), before the response ends. When the provider gives no token counts, the row carries an estimate instead, marked `usageEstimated`, so a request is never counted as free:

- A caller that disconnects, or a stream cut by a content rule, is charged the request, the output received so far, and an allowance for output the provider may have produced but the gateway never read.
- A server that sends no usage is charged the request and the output received. This is every stream on a route with `extra.streamUsage: false`, and any compatible server that ignores `stream_options`, so set that option only for a server that refuses it, and expect those numbers to be estimates.
- A provider that reports only a total keeps that total; its split between input and output is a guess, so the row is marked `usageEstimated`.
- A failed provider call is charged the request's input, because the gateway cannot tell whether it was billed. A provider that refuses a request therefore still counts toward budgets, a little.

Estimates lean high: about three bytes of text a token, and a flat amount for each image. They are not provider billing figures.

A budget is checked when a request starts and the spend lands when it ends, so requests that run at the same time can together pass a block budget before any of them is counted. Where that matters, set a concurrency limit on the client or route set beside the budget.

[Budgets](./budgets) count these rows for the client (`mcp_client` scope), the route set's project and the deployment. When a block budget is used up, requests answer `429` with code `insufficient_quota` and a `Retry-After` until the budget's period resets.

A client's own rate limit and its route set's limit both apply: the route set's limit counts each client separately, and a request must pass both. Over either limit, requests answer `429` with code `rate_limit_exceeded` and `Retry-After`. In cluster mode the per-minute counts are shared across replicas.

Usage by model name and client is shown under **MCP → AI routes**.

Costs come from the same pricing table as workflow runs, including `LLM_PRICING_OVERRIDES_JSON`. `/v1` traffic is also priced for `azure_openai` models and for embedding models, which workflow runs are not: an Azure route priced this way counts toward USD budgets, while an Azure workflow run stays unpriced. A model with no price adds nothing to a USD budget, so set a price override for an `openai_compatible` route that needs one.

## Model allowlists

Each request is checked against the [model allowlists](../security/model-allowlists.md) before it reaches the provider: the deployment list and the list of the route set's project (the Default project's list for a route set with no project). Moving a route set to another project moves it to that project's list. For Azure OpenAI the name checked is the deployment. With no entries anywhere, every model is allowed.

## Addresses and certificates

A client's address list and certificate pins apply here as they do on the MCP gateway, and `NETWORK_ALLOW_MCP_GATEWAY` covers `/v1/*` as well as `/mcp/*`. See [Network controls](../security/network-controls.md).

## Errors

Errors use the OpenAI shape: `{"error": {"message", "type", "code", "param"}}`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `content_filter` | Content rules blocked the prompt. |
| 400 | `unsupported_parameter` and others | The request is malformed or asks for something the route cannot do. |
| 401 | `invalid_api_key` | No token, or an unknown, revoked or expired one, or the client's pinned certificate was not presented. |
| 403 | `access_denied` | The caller's address is not allowed. The body never names the list or the address. |
| 403 | `model_not_allowed` | The model allowlist refuses the route's model. |
| 404 | `model_not_found` | The model name is unknown, disabled or not granted to the client. |
| 429 | `rate_limit_exceeded` | Over the client's rate limit. |
| 429 | `insufficient_quota` | A block budget is used up. |
| 502 | `upstream_error` | The provider failed. Its error text is never passed on. |
| 503 | `service_unavailable` | Budgets, content rules or the allowlist could not be checked; the request was not sent. |

See the [API endpoints](../api/endpoints#v1-ai-gateway) for the admin API.

## Concepts

- [LLM gateway vs MCP gateway: what each one governs](../learn/operations/llm-gateway-vs-mcp-gateway)
- [Controlling LLM and agent costs](../learn/operations/llm-cost-control)
- [LLM gateway](../glossary/llm-gateway) (glossary)
