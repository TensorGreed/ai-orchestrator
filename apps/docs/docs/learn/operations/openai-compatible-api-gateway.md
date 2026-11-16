---
title: "Move OpenAI-style clients to a governed gateway"
sidebarTitle: "Move clients to a /v1 gateway"
description: "Migrate apps that use an OpenAI SDK to a self-hosted /v1 endpoint: one key per app, model names, allowlists, budgets, rate limits and the errors to handle."
level: intermediate
about: llm-gateway
related: [llm-gateway, model-allowlist, budget, rate-limit]
---

# Move OpenAI-style clients to a governed gateway

An application that already uses an OpenAI SDK can move to a self-hosted, OpenAI-compatible gateway by changing two settings: the base URL and the API key. The work is on the gateway side: give each application its own key, publish the model names it already uses, and set the allowlist, budget and rate limit that apply to it. Then check that the app handles the gateway's refusals, and that it calls nothing the gateway does not serve.

This guide is the migration checklist for L2M's [/v1 AI gateway](/product/ai-gateway). The product page lists every option; [LLM gateway vs MCP gateway](/learn/operations/llm-gateway-vs-mcp-gateway) explains what an <Term id="llm-gateway">LLM gateway</Term> is for. Here we go app by app.

## Step 0: check what the app calls

L2M's gateway serves four paths. Anything else under `/v1` answers `404` with code `unknown_url`:

| Path | Served |
|---|---|
| `POST /v1/chat/completions` | Yes, with streaming, tools, `response_format` and images as data URLs |
| `POST /v1/embeddings` | Yes, `float` or `base64` encoding |
| `GET /v1/models`, `GET /v1/models/{model}` | Yes, only the models granted to the caller |
| Responses, legacy completions, images, audio, files, batches, moderation, assistants | No |

Search the code for the SDK calls it makes, for example `grep -rn "responses.create\|images.generate\|audio\.\|files.create" src/`. An app built on the Responses API needs to move to chat completions first, or stay off the gateway.

Then check the request options. These differ from a direct call:

- **`n` greater than 1** answers `400`. Only one choice per request.
- **`logprobs`** answers `400`.
- **Image URLs** answer `400`. Send images as `data:image/...;base64,` URLs; the gateway never fetches a URL.
- **Options the provider behind the route cannot honour** (for example `seed`, `stop` or `tool_choice` on a provider without them) answer `400` with code `unsupported_parameter` and the option as `param`. They are never dropped silently.
- **Tool calls** come back as `tool_calls` for the app to run, exactly as before. The gateway does not run tools.

## Step 1: publish the model names the app already uses

A **route** maps a public model name (its alias) to a provider, an upstream model and a stored key. Routes live in a **route set**, and a route set belongs to a project, whose budgets and model allowlist then apply.

The cheapest migration keeps the names the code already sends. Aliases may use letters, digits and `. _ : / -`, so `gpt-4o-mini` or `text-embedding-3-small` are valid aliases. Each alias is unique across the deployment, so pick one meaning per name.

Under **MCP → AI routes** (admin), create a route set for the team, then its routes. With the admin API the same thing is two calls:

```http
POST /api/ai-gateway/route-sets
{ "name": "Support apps", "projectId": "<project id>",
  "rateLimit": { "requestsPerMinute": 120, "burst": 20, "maxConcurrent": 8 } }

POST /api/ai-gateway/route-sets/{id}/routes
{ "alias": "gpt-4o-mini", "kind": "chat", "providerId": "openai",
  "model": "gpt-4o-mini", "secretRef": { "secretId": "<secret id>" },
  "defaults": { "maxTokens": 1024 } }
```

The provider key is a stored secret, referenced by id and never returned. Apps no longer hold it. That is the main point of the move: rotating or revoking the provider key is one change in L2M, not one per app.

An alias can point at a different provider than its name suggests. Use that with care: a name that says one model and serves another confuses whoever reads the code later. A neutral alias such as `support-chat` is clearer when you plan to change models.

## Step 2: one client token per application

Callers authenticate with L2M client tokens, the same ones the [MCP gateway](/product/mcp-gateway) uses. Create one client per application, not one per team, so usage, limits and revocation are per app:

1. **MCP → Clients → New client**. A client that only calls `/v1` needs no toolset. Copy the token: it is shown once.
2. Open the client's **Governance** and tick the route sets it may call under **AI routes**. The client sees only those models; any other name answers `404 model_not_found`, the same as a name that does not exist.
3. Optional: set the client's own rate limit (calls per minute, burst, calls at once) in the same section. It applies on top of the route set's limit, not instead of it: the route set's limit counts each client separately, and a request must pass both.
4. Optional: add an address list or certificate pin for the client (see [Network controls](/security/network-controls)).

Rotating a token later (**Rotate**, or `POST /api/mcp/clients/:id/rotate` with `{ "graceHours": 24 }`) keeps the old token working for the grace window, so the app can be redeployed without downtime.

## Step 3: allowlist, budget and limits

Three controls decide whether a request reaches the provider. All are optional; set the ones you need before the first app moves.

- **<Term id="model-allowlist">Model allowlist</Term>.** The deployment list and the route set's project list are checked against the route's upstream model (for Azure OpenAI, the deployment name). With no entries, every model is allowed. A refused model answers `403 model_not_allowed`. See [Model allowlists](/security/model-allowlists).
- **<Term id="budget">Budget</Term>.** Under **Settings → Cost & quality → FinOps**, a block budget on the client (scope MCP client), the project or the deployment refuses requests once used up. Each request writes a usage row with tokens and estimated cost, and a provider that reports no usage is charged an estimate, so streams cannot run free. See [Budgets](/product/budgets).
- **<Term id="rate-limit">Rate limit</Term>.** The client's own limit and the route set's limit both apply. A client's limit is one allowance across its `/v1` and MCP traffic.

A budget is checked when a request starts and charged when it ends, so requests in flight together can pass a cap. Where that matters, set **calls at once** beside the budget.

## Step 4: switch the app

Both official OpenAI SDKs read `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment, so many apps need no code change at all:

```bash
OPENAI_BASE_URL=https://l2m.example.com/v1
OPENAI_API_KEY=l2m_mcp_...   # the client token from Step 2
```

Code that sets the base URL explicitly changes one argument:

```python
client = OpenAI(base_url="https://l2m.example.com/v1", api_key=os.environ["L2M_CLIENT_TOKEN"])
```

Check it before you deploy:

```bash
curl -s https://l2m.example.com/v1/models -H "Authorization: Bearer $L2M_CLIENT_TOKEN"
```

The answer lists the aliases this client may call. If a name the app uses is missing, the grant or the route is wrong.

## Step 5: handle the gateway's answers

Errors keep the OpenAI shape, `{"error": {"message", "type", "code", "param"}}`, so SDK exception classes still work. The codes that are new to an app that called a provider directly:

| Status and code | Cause | What the app should do |
|---|---|---|
| `401 invalid_api_key` | Token missing, unknown, revoked or expired, or the client pins certificates and none it accepts was presented | Fail and alert; retrying does not help |
| `403 access_denied` | Address not allowed for this client | Fail; fix the network settings |
| `403 model_not_allowed` | The allowlist refuses the route's model | Fail; ask for the model to be allowed |
| `404 model_not_found` | Alias unknown or not granted | Fail; fix the grant or the name |
| `400 content_filter` | [Content rules](/product/content-rules-engine) blocked the prompt | Show a message; do not retry the same prompt |
| `429 rate_limit_exceeded` | Over the client's or route set's limit | Retry after `Retry-After` |
| `429 insufficient_quota` | A block budget is used up | Stop; `Retry-After` points to the end of the budget period |
| `429 upstream_rate_limited` | The provider rate limited the route | Retry after `Retry-After` (30 seconds) |
| `502 upstream_error` | The provider failed; its error text is not passed on | Retry with backoff |
| `503 service_unavailable` | Budgets, rules or the allowlist could not be checked; nothing was sent | Retry after `Retry-After` |

A blocked answer arrives as a normal response with `finish_reason: "content_filter"`. In a stream, a provider failure ends with an error event `upstream_error` and `[DONE]` with no finish reason, so check `finish_reason` before treating a streamed answer as complete.

Watch the SDK's own retries. Both official SDKs retry 429 and 5xx responses twice by default. For `insufficient_quota` that only adds two refused requests, since the budget will not reset within seconds. If the app has its own retry loop, set the SDK's `max_retries` (Python) or `maxRetries` (JavaScript) to 0 to avoid retrying twice over, and treat `insufficient_quota` as final.

## Step 6: cut over one app at a time

1. Move a low-traffic app first, with a small token budget in **warn** mode so you see what it spends without refusing anything.
2. Compare the usage under **MCP → AI routes** (last 24 hours, 7 or 30 days) with the provider's own usage page for the same period. The gateway's costs are estimates from L2M's price table, not provider billing.
3. Switch the budget to **block** at a level above what you saw.
4. Remove the provider key from the app's environment, so the gateway is the only way out. Network rules that stop the app from reaching the provider directly make this stick.
5. Repeat for the next app.

## What the gateway does not do

Say these out loud before teams depend on it:

- **No fallback or load balancing.** One alias maps to one provider and model. When the provider fails, the caller gets `502` or `429`; the gateway does not try another route, provider or region. Build failover in the app (a second alias) if you need it.
- **No answer caching.** Every request goes to the provider and is charged.
- **No other endpoints.** Only chat completions, embeddings and the model list, as in Step 0.
- **No bring-your-own provider key.** Callers use L2M tokens; the provider key always comes from L2M (the route's stored secret, or the server's environment key when the route names none).
- **No prompt storage.** Usage rows hold tokens, cost, latency, model and outcome, never prompts or answers. If you need content for debugging, that is opt-in tracing, not the gateway.
- **Model-judged output checks do not run.** Content rules that need a model call to judge an answer cannot be bound to a route set or client.

## Try it in L2M

Create a route set with one route under **MCP → AI routes**, a client under **MCP → Clients**, tick the route set in the client's **Governance**, and run the `curl` from Step 4. Then point a small script that uses the OpenAI SDK at the gateway with the two environment variables and watch its request appear in the route set's usage.

## Further reading

- [OpenAI API reference: chat completions](https://platform.openai.com/docs/api-reference/chat) (platform.openai.com)
- [OpenAI Python SDK README: retries and base URL](https://github.com/openai/openai-python) and [OpenAI Node SDK README](https://github.com/openai/openai-node) (GitHub)
- L2M docs: [/v1 AI gateway](/product/ai-gateway), [Model allowlists](/security/model-allowlists), [Budgets](/product/budgets), [MCP gateway clients](/product/mcp-gateway), [LLM gateway vs MCP gateway](/learn/operations/llm-gateway-vs-mcp-gateway), [Controlling LLM and agent costs](/learn/operations/llm-cost-control)
