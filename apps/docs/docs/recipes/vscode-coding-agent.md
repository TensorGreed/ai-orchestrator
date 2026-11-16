---
title: "A coding agent in VS Code backed by your own workflow"
description: "Connect the L2M VS Code extension to a workflow that returns chat, code blocks, patch previews and commands that run only after you approve them."
keys: "model"
keysNote: "A model (local Ollama as shipped) and the VS Code extension"
tags: ["agent","coding","vscode"]
nodeCount: 6
sample: "vscode-l2m-coding-agent-flow.json"
related: ["human-in-the-loop","ai-agent","approval-gate","agent-memory"]
---

<!--
  Generated from samples/workflows/vscode-l2m-coding-agent-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# A coding agent in VS Code backed by your own workflow

**What you get:** A chat panel in VS Code whose answers come from an L2M workflow you can edit: code blocks, file patches you preview and apply, and commands you approve.

**Needs:** A model (local Ollama as shipped) and the VS Code extension · **Time:** 20 minutes · **Nodes:** 6

The L2M VS Code extension sends each chat message, with a bounded bundle of workspace context, to an L2M workflow. This workflow is the server side: a **Webhook Input** with the path `vscode-l2m-agent`, an Agent Orchestrator with a chat model and session memory, an **Output Parser** that checks the reply against a JSON contract, and an **Output**. The extension turns the reply into chat text, code blocks and actions. It changes files or runs commands only after you approve each one in a modal dialog. The model and the prompt live in the workflow, so you can switch models without touching the editor. As shipped, the chat model is `qwen2.5:7b` on a local Ollama server.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/vscode-l2m-coding-agent-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/vscode-l2m-coding-agent-flow.json" download>vscode-l2m-coding-agent-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/vscode-l2m-coding-agent-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Point the **Chat Model** node at a model you have: pull `qwen2.5:7b` into Ollama, or switch the provider to OpenAI, Anthropic or any OpenAI-compatible endpoint with its key as a stored secret. A larger model follows the JSON contract more reliably. Save.
4. Create an API key in **Settings → Account → API Keys** (a builder role or above can run workflows). It is shown once.
5. Install the extension. Build the `.vsix` from `apps/vscode-l2m-agent` or take it from a CI run, then `code --install-extension vscode-l2m-agent.vsix`. See [VS Code extension](/getting-started/vscode-extension#install-development-build).
6. In VS Code settings, set `l2mAgent.apiBaseUrl` (default `http://localhost:4000`), `l2mAgent.workflowId` to `wf-vscode-l2m-coding-agent` (or leave it empty to find the workflow by its webhook path), and `l2mAgent.authToken` to the key. Put the key in your user settings, not in a workspace `settings.json` that might be committed.
7. Open **L2M Agent** in the Activity Bar and ask for a change in the open file.

## How it works

<figure class="recipe-diagram">
<svg viewBox="56 196 1238 302" role="img" aria-labelledby="rd-vscode-coding-agent-title rd-vscode-coding-agent-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-vscode-coding-agent-title">Diagram of the VS Code L2M Coding Agent workflow</title><desc id="rd-vscode-coding-agent-desc">Runs VS Code Webhook Input, then Coding Agent Orchestrator, then Contract Parser, then Structured Output. Chat Model is attached to Coding Agent Orchestrator as its chat model; Workflow Memory is attached to Coding Agent Orchestrator as its memory.</desc><defs><marker id="rd-vscode-coding-agent-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M270 247 C344 247 344 247 418 247" marker-end="url(#rd-vscode-coding-agent-arrow)"/><path class="rd-edge" d="M610 247 C684 247 684 247 758 247" marker-end="url(#rd-vscode-coding-agent-arrow)"/><path class="rd-edge" d="M950 247 C1014 247 1014 247 1078 247" marker-end="url(#rd-vscode-coding-agent-arrow)"/><path class="rd-edge is-port" d="M515 274 C515 347 515 347 515 420"/><path class="rd-edge is-port" d="M515 274 C515 347 745 347 745 420"/><g class="rd-node" data-kind="step" transform="translate(80 220)"><title>VS Code Webhook Input (webhook_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">VS Code Webhook Input</text><text class="rd-type" x="12" y="40">webhook_input</text></g><g class="rd-node" data-kind="agent" transform="translate(420 220)"><title>Coding Agent Orchestrator (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Coding Agent Orchestrat…</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(420 420)"><title>Chat Model (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat Model</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="memory" transform="translate(650 420)"><title>Workflow Memory (local_memory)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Workflow Memory</text><text class="rd-type" x="12" y="40">local_memory</text></g><g class="rd-node" data-kind="step" transform="translate(760 220)"><title>Contract Parser (output_parser)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Contract Parser</text><text class="rd-type" x="12" y="40">output_parser</text></g><g class="rd-node" data-kind="step" transform="translate(1080 220)"><title>Structured Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Structured Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| VS Code Webhook Input | [`webhook_input`](/nodes/reference/input#webhook-input-—-webhook-input) | Step in the run |
| Coding Agent Orchestrator | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Step in the run |
| Contract Parser | [`output_parser`](/nodes/reference/utility#output-parser-—-output-parser) | Step in the run |
| Structured Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Chat Model | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Coding Agent Orchestrator on its `chat_model` port |
| Workflow Memory | [`local_memory`](/nodes/reference/utility#local-memory-—-simple-memory) | Attached to Coding Agent Orchestrator on its `memory` port |

6 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## The request and the contract

The extension calls `POST /api/webhooks/execute/stream` (or `/api/webhooks/execute` with streaming off) with the API key as a bearer token. The body has `user_prompt`, `session_id`, its own `system_prompt`, and `variables` with the workspace context: the active file and selection, open editors, diagnostics, git status and diffs, pinned files, the extension's compacted memory, recent turns, and `actionResults`, which says which earlier patches and commands you approved. The [settings](/getting-started/vscode-extension#context-budget-tuning) cap each part, for example 12,000 characters per file and 60,000 in all.

The agent's system prompt asks for exactly one JSON object: `status` (`complete` or `needs_more_info`), `message`, `actions` (patches with a single-file unified diff, or commands), `codes`, `attachments`, `context_update` and `follow_up_question`. It also says never to claim a change unless `actionResults` shows it was approved. **Contract Parser** checks the reply in `anything_goes` mode: the required top-level fields, the `status` values and the string fields' types, not the items inside the arrays. It asks the model once to fix a bad reply, and if that fails too it returns `parsed: null` with a warning instead of failing the run.

## What a run does

We sent the extension's request shape to a fresh install with a request to add a docstring, without VS Code and without a model key.

**With the echo provider**, the agent echoed the prompt back, the parser found no `status` field even after one retry (`Output parsing failed: Missing required field: status`), and the workflow returned an empty `result`. The streaming route sent `execution_started`, `node_start`, `node_activity`, `node_complete` and a final `result` event.

**With a scripted stand-in model** that answers with a valid contract, the parser accepted it on the first try. The workflow returned the object as a JSON string in `result`, with a `patch` action for `src/math.py`, its unified diff, and a `context_update`. We did not drive the VS Code side; the rest of this page describes it from the extension's source.

## Safety model

The extension, not the workflow, decides what touches your machine:

- **Patches.** **Preview** opens a diff view of the result before anything is written. **Apply** asks again in a modal dialog, then writes the file. A patch must be a single-file unified diff whose target matches the action's file. The path is resolved against the first workspace folder and refused if it ends up outside it, whether through `..` or an absolute path. The check works on the path text; it does not resolve symbolic links.
- **Commands.** **Preview** shows the command and its working directory. **Run** asks in a modal dialog, then types the command into a new VS Code terminal named **L2M Agent Action**, where you can watch it. The working directory must also be inside the workspace. The extension never runs a command on its own, and it asks for approval even when the workflow sets `requiresApproval: false`.
- **Results.** Each approval, rejection or failure is saved with the session and sent back in `actionResults` on the next request. A command's terminal output is not sent back.

The workflow sees only what the extension sends. The sample attaches no tools, so the agent cannot read other files or run anything itself. If you attach MCP tools, those run on the L2M server under your tool rules, outside this approval flow.

## The webhook path is open as shipped

The extension uses the signed-in `/api/webhooks/execute` routes: they check your API key and do not look at the node's auth settings. The **Webhook Input** node also serves `POST /webhook/vscode-l2m-agent`, and the sample sets no auth mode on it. On our install that URL ran the workflow with no credentials. If others can reach your L2M, open the node and set **Auth Mode** to **Bearer Token** or **HMAC SHA256**; the extension keeps working. Clearing the **Path** does not close the URL: an empty path falls back to the node id, so the workflow answers at `/webhook/webhook_1` instead. It also stops the extension from finding the workflow, unless `l2mAgent.workflowId` is set. See [Secure webhooks](/security/secure-webhooks#webhook-auth-modes).

## Make it yours

- Rewrite the system prompt for your stack: test commands, code style, the files that matter.
- Lower the context limits in the extension settings for small local models, or raise them for large-context models.
- Attach read-only MCP tools (a repository search, docs lookup) on the agent's `tool` port so it can look things up on the server.
- Each chat session sends its own `session_id`, and the workflow's memory keeps the last 24 messages of it (`maxMessages`); the extension also sends its own compacted memory.

## Make it safer

These controls are optional; the recipe runs without them.

- Set an auth mode on the Webhook Input (above), so its public URL does not run the workflow for anyone who can reach L2M.
- Give the extension a key of its own, so you can revoke it alone.
- Cap model spend with a [budget](/product/budgets).
- If you attach tools that change things, set [tool policy](/product/mcp-tool-policy) rules or require [approval](/guides/human-approval-for-agent-tool-calls) for them.

## Further reading

- [VS Code extension](/getting-started/vscode-extension)
- [Secure webhooks](/security/secure-webhooks)
- [Human in the loop for AI agents](/learn/agents/human-in-the-loop)
- [Pattern library](/patterns/)
