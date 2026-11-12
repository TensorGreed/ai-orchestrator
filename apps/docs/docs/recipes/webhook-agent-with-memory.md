---
title: "Webhook to AI agent with memory and MCP tools"
description: "Trigger an agent from a webhook, give it session memory and MCP tools, and secure the webhook with a bearer token or HMAC signature."
keys: "model"
keysNote: "A model: local Ollama or a provider key"
tags: ["agent","mcp","webhook","memory"]
nodeCount: 7
sample: "agentic-mcp-flow.json"
demo: "wf-agent-mcp-webhook"
demoRecorded: false
related: ["ai-agent","agent-memory","human-in-the-loop","mcp-tool"]
---

<!--
  Generated from samples/workflows/agentic-mcp-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Webhook to AI agent with memory and MCP tools

**What you get:** An agent behind a webhook URL, with per-session memory and two MCP tools, that any app can call with a question and a session id.

**Needs:** A model: local Ollama or a provider key · **Nodes:** 7

A **Webhook Input** node at `POST /webhook/agent-demo` passes `system_prompt`, `user_prompt` and `session_id` from the request body to an Agent Orchestrator. The agent has a chat model, a **Simple Memory** node keyed by the session id, and two tools from the mock MCP server built into L2M. As shipped, the chat model points at a local Ollama server (`http://localhost:11434/v1`, model `qwen2.5:7b`), so you need that model, or you point the node at another one. As shipped, the webhook also has no authentication: secure it before you expose it.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/agentic-mcp-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-agent-mcp-webhook" target="_self">Open it in the demo</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/agentic-mcp-flow.json" download>agentic-mcp-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/agentic-mcp-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Open the chat model node and point it at a model you have: pull `qwen2.5:7b` into Ollama, type another model name, or switch the provider. Save.
4. Send a request:

   ```bash
   curl -X POST http://localhost:4000/webhook/agent-demo \
     -H "Content-Type: application/json" \
     -d '{"system_prompt": "You are a helpful assistant.", "user_prompt": "What is 12 * 7?", "session_id": "demo-2"}'
   ```
5. Send a second request with the same `session_id` and a follow-up question. The agent now sees the first exchange.
6. Before anyone else can reach the URL, secure it (see below).

## How it works

<figure class="recipe-diagram">
<svg viewBox="76 156 1148 262" role="img" aria-labelledby="rd-webhook-agent-with-memory-title rd-webhook-agent-with-memory-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-webhook-agent-with-memory-title">Diagram of the Agentic MCP + Memory Webhook Flow workflow</title><desc id="rd-webhook-agent-with-memory-desc">Runs Webhook Input, then Agent Orchestrator, then Output. OpenAI Chat Model is attached to Agent Orchestrator as its chat model; Simple Memory is attached to Agent Orchestrator as its memory; MCP Time Tool is attached to Agent Orchestrator as its tool; MCP Calculator Tool is attached to Agent Orchestrator as its tool.</desc><defs><marker id="rd-webhook-agent-with-memory-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M290 207 C374 207 374 207 458 207" marker-end="url(#rd-webhook-agent-with-memory-arrow)"/><path class="rd-edge" d="M650 207 C754 207 754 207 858 207" marker-end="url(#rd-webhook-agent-with-memory-arrow)"/><path class="rd-edge is-port" d="M555 234 C555 287 615 287 615 340"/><path class="rd-edge is-port" d="M555 234 C555 287 795 287 795 340"/><path class="rd-edge is-port" d="M555 234 C555 277 965 277 965 320"/><path class="rd-edge is-port" d="M555 234 C555 277 1105 277 1105 320"/><g class="rd-node" data-kind="step" transform="translate(100 180)"><title>Webhook Input (webhook_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Webhook Input</text><text class="rd-type" x="12" y="40">webhook_input</text></g><g class="rd-node" data-kind="agent" transform="translate(460 180)"><title>Agent Orchestrator (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Agent Orchestrator</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(520 340)"><title>OpenAI Chat Model (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">OpenAI Chat Model</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="memory" transform="translate(700 340)"><title>Simple Memory (local_memory)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Simple Memory</text><text class="rd-type" x="12" y="40">local_memory</text></g><g class="rd-node" data-kind="tool" transform="translate(870 320)"><title>MCP Time Tool (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP Time Tool</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="tool" transform="translate(1010 320)"><title>MCP Calculator Tool (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP Calculator Tool</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="step" transform="translate(860 180)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Webhook Input | [`webhook_input`](/nodes/reference/input#webhook-input-—-webhook-input) | Step in the run |
| Agent Orchestrator | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| OpenAI Chat Model | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Agent Orchestrator on its `chat_model` port |
| Simple Memory | [`local_memory`](/nodes/reference/utility#local-memory-—-simple-memory) | Attached to Agent Orchestrator on its `memory` port |
| MCP Time Tool | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent Orchestrator on its `tool` port |
| MCP Calculator Tool | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent Orchestrator on its `tool` port |

6 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## What a run does

We ran the sample on a fresh install. Two things are worth knowing before you call it from an app.

**A model error still returns 200.** With no `qwen2.5:7b` in the local Ollama, the request returned HTTP 200 with `{"output":{"result":"Provider ollama request failed (404): ... model 'qwen2.5:7b' not found ..."}}`. The run is recorded as a success; the Agent node's `stopReason` is `error`. If an app gets text like that back, open the run and look at the Agent node.

**Memory, checked with the echo model.** To test the webhook and memory without a model, we set the chat model to the built-in echo provider. Two requests with `session_id: "demo-2"` returned `Echo: What is 12 * 7?` and then `Echo: And what time is it in Toronto?`. The second run's agent messages held the first question and answer before the new question: that is the memory. Echo never calls tools, so this check says nothing about tool use; a model that supports tool calling can call `get_current_time` and `calculator`.

Memory keeps the last 20 messages of a session (`maxMessages`) and, with **Persist Tool Messages** off, leaves tool results out of it. The tools' connection names an HTTP endpoint (`http://127.0.0.1:7001/mcp`), but the `mock-mcp` server runs inside L2M: nothing has to listen on that port.

## Secure the webhook

With no auth mode set, anyone who can reach your L2M can call the agent and spend your model budget. On the Webhook Input node:

- **Bearer token.** Set the auth mode to `bearer_token`, the auth header name to `authorization`, and pick a stored secret that holds the token. Callers then send `Authorization: Bearer <token>`. We checked: without the header the call gets `401 {"error":"Unauthorized webhook request"}`; with it, the agent answers.
- **HMAC signature.** For callers that can sign requests, `hmac_sha256` checks a hex HMAC-SHA256 of `timestamp + "." + raw body`, sent with a timestamp header. Requests outside the replay window (300 seconds by default) and repeated signatures are rejected.
- **Idempotency.** Turn it on so a retried request with the same `Idempotency-Key` returns the first result instead of running the agent again; the same key with a different body gets `409`.
- **Allowed addresses.** List the IPs or CIDR ranges that may call the trigger.

See [Secure webhooks](/security/secure-webhooks) for the signing format and error codes.

## Make it yours

- Switch the chat model to OpenAI, Anthropic, Gemini or any OpenAI-compatible endpoint, with its key stored as a [secret](/security/secrets).
- Replace the mock tools with a server from your [MCP server registry](/product/mcp-server-registry).
- Raise `maxMessages` on the memory node for longer conversations, or lower it to keep prompts small.

## Make it safer

These controls are optional; the recipe runs without them.

- The sample takes `system_prompt` from the request, so any caller can rewrite the agent's instructions. Write the system prompt on the agent node instead.
- Require approval before write tools: with **Ask before write tools** on, the agent pauses before `calculator` (it has no read-only annotation). See [human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls).
- Cap what callers can spend with a workflow [budget](/product/budgets).

## Further reading

- [Secure webhooks](/security/secure-webhooks)
- [Agent loop: session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse)
- [Human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls)
- [Pattern library](/patterns/)
