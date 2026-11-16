---
title: "Two-turn report and code helper with session artifacts"
description: "Import a chat workflow that remembers artifacts between turns, routes follow-up intents and returns a PDF or code help on request."
keys: "model"
keysNote: "A model with tool calling (local Ollama as shipped) and an MCP server"
tags: ["agent","mcp","memory","pdf"]
nodeCount: 16
sample: "two-turn-report-code-helper-flow.json"
related: ["agent-memory","ai-agent","mcp-tool","tool-calling","max-iterations"]
---

<!--
  Generated from samples/workflows/two-turn-report-code-helper-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Two-turn report and code helper with session artifacts

**What you get:** A chat endpoint that builds a PDF report from MCP data on one turn, saves it for the session, and writes a Python script from that saved report on a later turn.

**Needs:** A model with tool calling (local Ollama as shipped) and an MCP server · **Time:** 20 minutes · **Nodes:** 16

A **Webhook Input** at `POST /webhook/two-turn-report-code-helper` takes a `user_prompt` and a `session_id`. **Session Artifact Load** reads the report saved earlier in that session, if any. An **Agent Orchestrator** with a chat model, a **Simple Memory** and every tool of one MCP server answers with one JSON object: `status`, `intent`, `final_html`, `python_code`, `follow_up_question`, `chart_data` and `artifact_context`. An **Output Parser** checks it, and a **Chat Intent Router** picks a branch. A report turn prints `final_html` to PDF, saves the report with **Session Artifact Save** and returns it with the PDF attached. A code turn returns the script. Anything else returns a message. As shipped, the chat model is `qwen2.5:7b` on a local Ollama server, the MCP endpoint is a placeholder, and the webhook has no authentication.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/two-turn-report-code-helper-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/two-turn-report-code-helper-flow.json" download>two-turn-report-code-helper-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/two-turn-report-code-helper-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Point **Chat Model** at a model that can call tools and keep to a JSON format: pull `qwen2.5:7b` into Ollama, or switch the provider and pick a stored key. To check the plumbing without a model, set its `providerId` to `echo` in the JSON file and import it again (the **Provider** list has no echo entry). Echo never calls a tool.
4. Point **MCP Tools** at your MCP server: set `connection.endpoint` to its streamable HTTP URL (`http://127.0.0.1:7001/mcp` is a placeholder). `toolName: "__all__"` gives the agent every tool the server lists. For a token, set `connection.authType` to `bearer` and a `secretRef`, or register the server in the [MCP server registry](/product/mcp-server-registry) and set `registryServerId`.
5. Install Chromium for Playwright for the PDF: `pnpm exec playwright install chromium` from the repo root, or set `PDF_CHROMIUM_EXECUTABLE_PATH`.
6. Ask for a report, with a session id:

   ```bash
   curl -X POST http://localhost:4000/webhook/two-turn-report-code-helper \
     -H "Content-Type: application/json" \
     -d '{"user_prompt": "Build a PDF report of our keys by cloud", "session_id": "team-a-1"}'
   ```
7. Ask for the code in the same session: send `"user_prompt": "Now give me a Python script that regenerates it nightly without AI"` with the same `session_id`.
8. Read `output.result`. A report turn has the PDF in `attachments` (`filename`, `sizeBytes` and a `data:` URL in `downloadUrl`). A code turn has `{ language, source }` in `codes`. When the agent needs more, `status` is `needs_more_info` and `follow_up_question` says what.

## How it works

<figure class="recipe-diagram">
<svg viewBox="56 66 2158 472" role="img" aria-labelledby="rd-two-turn-report-helper-title rd-two-turn-report-helper-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-two-turn-report-helper-title">Diagram of the Two-Turn MCP Report + Code Helper workflow</title><desc id="rd-two-turn-report-helper-desc">Runs Webhook Input, then Load Latest Report Artifact, then Agent Orchestrator, then Output Parser, then Route Intent, then PDF Output, then Build Code Response, then Build Message Response, then Save Latest Report Artifact, then Code Output, then Message Output, then Build Report Response, then Report Output. Chat Model is attached to Agent Orchestrator as its chat model; Simple Memory is attached to Agent Orchestrator as its memory; MCP Tools is attached to Agent Orchestrator as its tool.</desc><defs><marker id="rd-two-turn-report-helper-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M270 247 C284 247 284 247 298 247" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M490 247 C524 247 524 247 558 247" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M750 247 C719 247 719 247 688 247" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M880 247 C924 247 924 247 968 247" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1160 247 C1199 247 1199 117 1238 117" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1160 247 C1334 247 1334 117 1508 117" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1430 117 C1469 117 1469 117 1508 117" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1700 117 C1714 117 1714 117 1728 117" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1920 117 C1959 117 1959 117 1998 117" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1160 247 C1199 247 1199 307 1238 307" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1430 307 C1469 307 1469 307 1508 307" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1160 247 C1199 247 1199 487 1238 487" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge" d="M1430 487 C1469 487 1469 487 1508 487" marker-end="url(#rd-two-turn-report-helper-arrow)"/><path class="rd-edge is-port" d="M655 274 C655 352 475 352 475 430"/><path class="rd-edge is-port" d="M655 274 C655 352 685 352 685 430"/><path class="rd-edge is-port" d="M655 274 C655 352 905 352 905 430"/><g class="rd-node" data-kind="step" transform="translate(80 220)"><title>Webhook Input (webhook_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Webhook Input</text><text class="rd-type" x="12" y="40">webhook_input</text></g><g class="rd-node" data-kind="step" transform="translate(300 220)"><title>Load Latest Report Artifact (session_artifact_load)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Load Latest Report Arti…</text><text class="rd-type" x="12" y="40">session_artifact_load</text></g><g class="rd-node" data-kind="agent" transform="translate(560 220)"><title>Agent Orchestrator (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Agent Orchestrator</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(380 430)"><title>Chat Model (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat Model</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="memory" transform="translate(590 430)"><title>Simple Memory (local_memory)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Simple Memory</text><text class="rd-type" x="12" y="40">local_memory</text></g><g class="rd-node" data-kind="tool" transform="translate(810 430)"><title>MCP Tools (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP Tools</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="step" transform="translate(690 220)"><title>Output Parser (output_parser)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output Parser</text><text class="rd-type" x="12" y="40">output_parser</text></g><g class="rd-node" data-kind="step" transform="translate(970 220)"><title>Route Intent (chat_intent_router)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Route Intent</text><text class="rd-type" x="12" y="40">chat_intent_router</text></g><g class="rd-node" data-kind="step" transform="translate(1240 90)"><title>PDF Output (pdf_output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">PDF Output</text><text class="rd-type" x="12" y="40">pdf_output</text></g><g class="rd-node" data-kind="step" transform="translate(1730 90)"><title>Build Report Response (helper_chat_response)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Build Report Response</text><text class="rd-type" x="12" y="40">helper_chat_response</text></g><g class="rd-node" data-kind="step" transform="translate(1510 90)"><title>Save Latest Report Artifact (session_artifact_save)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Save Latest Report Arti…</text><text class="rd-type" x="12" y="40">session_artifact_save</text></g><g class="rd-node" data-kind="step" transform="translate(2000 90)"><title>Report Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Report Output</text><text class="rd-type" x="12" y="40">output</text></g><g class="rd-node" data-kind="step" transform="translate(1240 280)"><title>Build Code Response (helper_chat_response)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Build Code Response</text><text class="rd-type" x="12" y="40">helper_chat_response</text></g><g class="rd-node" data-kind="step" transform="translate(1510 280)"><title>Code Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Code Output</text><text class="rd-type" x="12" y="40">output</text></g><g class="rd-node" data-kind="step" transform="translate(1240 460)"><title>Build Message Response (helper_chat_response)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Build Message Response</text><text class="rd-type" x="12" y="40">helper_chat_response</text></g><g class="rd-node" data-kind="step" transform="translate(1510 460)"><title>Message Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Message Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Webhook Input | [`webhook_input`](/nodes/reference/input#webhook-input-—-webhook-input) | Step in the run |
| Load Latest Report Artifact | [`session_artifact_load`](/nodes/reference/utility#session-artifact-load-—-session-artifact-load) | Step in the run |
| Agent Orchestrator | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Step in the run |
| Output Parser | [`output_parser`](/nodes/reference/utility#output-parser-—-output-parser) | Step in the run |
| Route Intent | [`chat_intent_router`](/nodes/reference/utility#chat-intent-router-—-chat-intent-router) | Step in the run |
| PDF Output | [`pdf_output`](/nodes/reference/output#pdf-output-—-pdf-output) | Step in the run |
| Build Code Response | [`helper_chat_response`](/nodes/reference/output#helper-chat-response-—-helper-chat-response) | Step in the run |
| Build Message Response | [`helper_chat_response`](/nodes/reference/output#helper-chat-response-—-helper-chat-response) | Step in the run |
| Save Latest Report Artifact | [`session_artifact_save`](/nodes/reference/utility#session-artifact-save-—-session-artifact-save) | Step in the run |
| Code Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Message Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Build Report Response | [`helper_chat_response`](/nodes/reference/output#helper-chat-response-—-helper-chat-response) | Step in the run |
| Report Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Chat Model | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Agent Orchestrator on its `chat_model` port |
| Simple Memory | [`local_memory`](/nodes/reference/utility#local-memory-—-simple-memory) | Attached to Agent Orchestrator on its `memory` port |
| MCP Tools | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent Orchestrator on its `tool` port |

12 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## What a run does

We ran it on a local install with two stand-ins: a local MCP server whose one tool, `list_keys`, returned 12 keys, and a scripted OpenAI-compatible model written to follow the system prompt. A real model's answers depend on the model.

**Turn 1**, "Build a PDF report of our keys by cloud", session `t1`. The Load node found nothing. The agent was offered `session_cache_list`, `session_cache_get`, `agent_clarify` and `http_mcp__list_keys`, called `list_keys`, then answered with a report object. The parser accepted it, and the router took the agent's own `intent: "report"`. **PDF Output** printed a one-page A4 file, `mcp-report-t1.pdf` (15,717 bytes), the Save node stored five fields as `latest_report`, and the reply carried the PDF in `attachments`. The run took about 0.7 seconds.

**Turn 2**, "Now give me a Python script that regenerates it nightly without AI", same session. The Load node found the report, and the agent's prompt held it as JSON. Memory added the first turn's question and answer, but not the tool result (**Persist Tool Messages** is off). The agent called no tool and answered with `intent: "code"`; the reply carried the script in `codes`, and the PDF and Save nodes were skipped.

**A new session asking for code** had no saved report, so the stand-in returned `status: "needs_more_info"` with a question, as the system prompt asks.

**With the echo provider**, the agent's answer is its own prompt. The parser asked once more (`maxRetries: 1`), then gave `parsed: null`, and the router fell back to keywords: "report" picked the report branch. The PDF held only the request text, and every field of the saved report was null. On the router, `intentSource: "explicit"` means the agent's intent was used, `keyword` means the fallback matched a keyword, and `default` means nothing matched.

## Memory, artifacts and the tool cache

The workflow keeps three things per session, under the namespace `two-turn-report-code-helper`:

- **Memory**: the last 20 messages (`maxMessages`), what the user asked and what the agent answered.
- **The artifact**: one exact JSON value under the key `latest_report`, which the next turn sees word for word instead of a summary. Each report turn replaces it.
- **The session tool cache**: each tool result from the agent's turns. With a `session_id`, the agent gets `session_cache_list` and `session_cache_get`, so it can reuse an earlier `list_keys` answer. In our runs each report turn stored one `list_keys` entry for its session.

All three need a `session_id`; without one, nothing is loaded or saved. They stay in the L2M database until you set `AGENT_MEMORY_RETENTION_DAYS` (by default they are kept): see [data retention](/operations/data-retention#what-each-setting-deletes) and [agent memory](/learn/agents/agent-memory).

## How the router decides

The **Chat Intent Router** reads `parsed.intent` first: `report`, `code`, `message` or a synonym such as `pdf` or `python`. If that is missing, it searches the request for its keywords: code words (`python`, `script`, `nightly` ...) beat report words (`report`, `pdf`, `chart` ...), and neither means a message.

With `requireArtifactForCode` on, a code request with no saved report takes a fourth branch, `missing_context`. The sample does not wire it, and with nothing there the run ends with no output, so add a reply node first. The router finds the report through `artifactPath`, <span v-pre>`results.load_report_artifact.latest_report`</span>, because its own input comes from the parser.

## What to check before you rely on it

The agent writes `final_html`, and Chromium renders it with scripts on; the URLs it loads go through the [outbound URL checks](/security/outbound-url-checks). The agent also writes the Python script. The prompt asks for direct REST calls, secrets from environment variables and no invented endpoints, but treat the script as a draft and read it before you run it.

If the MCP server is down, the run does not fail. With our server stopped, the agent saw only the three built-in tools, its `list_keys` call came back as `Tool 'list_keys' does not exist`, and it answered without data. Check `_mcpTools` on the Agent node when a report comes back empty.

## Make it yours

- Use your own data: the prompt names no product, so any MCP server with read tools works. Edit its report rules to name the tools and fields you want.
- Change what is kept: edit the Save node's `fields` list, and the next turn sees exactly those.
- Build the report from fixed nodes instead of model-written HTML: the [branded PDF inventory report](/recipes/key-inventory-pdf-report) draws charts from an MCP tool's answer with no model in the data path.

## Make it safer

These controls are optional; the recipe runs without them.

- Secure the webhook before anyone else can reach it, with a bearer token or an HMAC signature: see [webhook auth modes](/security/secure-webhooks#webhook-auth-modes).
- The agent gets every tool the server lists. Give it a token that can only read, and optionally hold tool calls for a person: see [human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls).
- Turn on `OUTBOUND_DENY_PRIVATE` (off by default) so model-written HTML cannot load internal URLs: see [outbound URL checks](/security/outbound-url-checks#configuration).
- Cap spend with a workflow [budget](/product/budgets).

## Further reading

- [Agent memory](/learn/agents/agent-memory)
- [Utility nodes reference](/nodes/reference/utility)
- [Output nodes reference](/nodes/reference/output)
- [Secure webhooks](/security/secure-webhooks)
- [Pattern library](/patterns/#_7-multi-turn-helper-with-session-artifacts)
