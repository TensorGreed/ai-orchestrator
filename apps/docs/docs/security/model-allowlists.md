---
description: "Limit which LLM providers and models L2M may call, for the whole deployment or one project, with builder warnings, audited refusals and replay reports."
---

# Model allowlists

An admin can limit which models L2M calls. A list is made of entries, each a
**provider** and a **model pattern**, and there are two kinds of list:

- the **deployment** list, which applies to every workflow and every gateway call;
- a **project** list, which applies to that project's workflows and to gateway
  toolsets that belong to that project.

Both are optional. With no entries anywhere, every model is allowed, exactly as
before, and nothing needs to be configured for a simple workflow.

## How a call is decided

A model call is allowed when it matches the deployment list (if that list has
entries) **and** the project's list (if that list has entries). An empty list
puts no limit of its own.

A project list can only narrow the deployment list, never widen it. If the
deployment allows only OpenAI models, a project entry for Anthropic does not let
that project call Anthropic: the deployment list still refuses the call.

| Deployment list | Project list | Result |
|---|---|---|
| empty | empty | every model allowed |
| `openai` / `gpt-4o*` | empty | only matching OpenAI models, in every project |
| `openai` / `*` | `openai` / `gpt-4o-mini` | that project: only `gpt-4o-mini`; other projects: any OpenAI model |
| `openai` / `gpt-4o*` | `anthropic` / `*` | that project: nothing (the deployment refuses Anthropic, the project refuses OpenAI) |

### Matching

- **Provider** is the provider id the call goes to: `openai`, `anthropic`,
  `azure_openai`, `openai_compatible`, `ollama`, `gemini`, `echo` (the built-in
  demo provider), or a community provider's id. **Any provider** (`*`) matches
  them all.
- **Model pattern** is matched against the model name the provider is sent,
  ignoring case. `*` matches any text (also none) and `?` one character; every
  other character is literal, so `gpt-4o*` matches `gpt-4o` and `gpt-4o-mini`
  but not `gpt-4.1`.
- For **Azure OpenAI** the model name is the deployment name, because that is
  what the request names.
- For **OpenAI compatible** the model name is the node's model field, whatever
  endpoint the node points at. To limit which endpoints model traffic may
  reach, use [data destinations](../product/data-labels-and-destinations.md) and
  the [outbound URL guard](./outbound-url-guard.md) as well.

## What is covered

Every model call goes through the same check before any request leaves the
server:

- LLM Call nodes and the provider chat model nodes;
- the chat model attached to an Agent or Supervisor, and the chat models of a
  Supervisor's workers;
- MCP sampling requests a server makes during a run, and on the
  [MCP gateway](../product/mcp-gateway.md), where the toolset's project decides
  which project list applies (a toolset with no project uses the deployment
  list alone);
- **Test connection** in the node editor (with the workflow's project);
- LLM judges of evaluations (with the workflow's project).

A sub-workflow is checked against its own project's list, and an error workflow
against its own.

Per-client sampling limits on the gateway still come from
[tool policy](../product/mcp-control-plane.md) rules of kind `sampling`; the
allowlist applies on top of them.

## When a call is refused

- In a run, the node fails with the error category `model_not_allowed`, for
  example *Model "gpt-5" on provider "openai" is not on the model allowlist of
  project "payments".* The node is not retried, because the same call would be
  refused again. A worker refused inside a Supervisor reaches the supervisor as
  that delegation's tool error.
- On the MCP gateway, the sampling request fails, so the tool call answers with
  a tool error that carries the same sentence.
- The provider test answers `403` with `code: "MODEL_NOT_ALLOWED"`.

Each refusal is written to the audit log as `model_allowlist.call_denied`, with
the provider, model, which list refused it, where the call came from (`run`,
`gateway_sampling`, `provider_test` or `eval_judge`) and the node, run, client
or toolset. A run (or a gateway session) records one event per node, provider
and model, however often it retries.

## Builder warnings

The node editor checks the model as you type it. When the workflow's project or
the deployment refuses it, a warning appears under the model fields. It is a
warning, not an error: the workflow still saves, and its runs fail at that node
until the model is changed or allowed. Workflow validation
(`POST /api/workflows/:id/validate`, which the import report's **Validate** uses)
lists the same warnings, with code `model_not_allowed` and severity `warning`.

A model chosen by an expression (<span v-pre>`{{ vars.model }}`</span>, for example) is only known at run time, so it
is not checked in the editor; the run still checks it.

## Replays

A replay that answers model calls from a golden run's model tape does not call
the model, so the allowlist does not refuse it. The check still runs and the
replay reports a `model_not_allowed` health warning for each recorded call the
allowlist would refuse now; it does not make the replay inconclusive. Model
calls a replay makes live (live models, or a lenient replay's tape misses) are
new calls and are refused like any other.

## Managing the lists

Open **Security → Models**. The deployment list is at the top; under it,
choose a project to see and edit its override. Only admins add and remove
entries; builders, operators and viewers see the lists read-only. Each list
holds at most 200 entries. Every change is audited as
`model_allowlist.entry_added` or `model_allowlist.entry_removed`.

The lists are stored in the database (`model_allowlist_entries`, SQLite and
Postgres), so a change applies to the next model call on every instance.

### API

| Method | Path | Role | |
|---|---|---|---|
| `GET` | `/api/model-allowlist` | any signed-in user | entries, providers to choose from, `canEdit` |
| `POST` | `/api/model-allowlist` | admin | `{ scope: "deployment" \| "project", projectId?, providerId, modelGlob, note? }` |
| `DELETE` | `/api/model-allowlist/:id` | admin | removes one entry |
| `GET` | `/api/model-allowlist/check?providerId=&model=&projectId=` | any signed-in user | `{ allowed, reason, message? }` for that model in that project |
