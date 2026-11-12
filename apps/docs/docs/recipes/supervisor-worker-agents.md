---
title: "Supervisor and worker agents: a runnable example"
description: "A supervisor agent hands work to a researcher and a calculator worker, each with its own tools. Imports and runs with no API key."
keys: "none"
keysNote: "No API key"
tags: ["agent","mcp","multi-agent"]
nodeCount: 11
sample: "supervisor-worker-swarm-flow.json"
demo: "wf-supervisor-worker-swarm"
demoRecorded: false
related: ["agent-loop","tool-calling","supervisor-agent","worker-agent"]
---

<!--
  Generated from samples/workflows/supervisor-worker-swarm-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Supervisor and worker agents: a runnable example

**What you get:** A Supervisor agent with two worker agents, each with its own chat model and MCP tools, that runs on a fresh install.

**Needs:** No API key · **Nodes:** 11

A Supervisor node coordinates two worker agents. The researcher has an MCP knowledge-base lookup tool; the computer has a calculator and a clock. The Supervisor sees each worker as one tool and decides which to call for each step, and each worker runs its own agent loop. Every agent uses the built-in echo provider and the bundled mock MCP server, so it runs with no API key. Echo never asks for a tool, so the Supervisor answers on its first turn and hands nothing off; attach a real chat model to see it delegate.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/supervisor-worker-swarm-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-supervisor-worker-swarm" target="_self">Open it in the demo</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/supervisor-worker-swarm-flow.json" download>supervisor-worker-swarm-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/supervisor-worker-swarm-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Run it as it is and open the run to see each step.
4. Then change one thing at a time (see below).

## How it works

<figure class="recipe-diagram">
<svg viewBox="56 36 1218 582" role="img" aria-labelledby="rd-supervisor-worker-agents-title rd-supervisor-worker-agents-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-supervisor-worker-agents-title">Diagram of the Supervisor + Worker Swarm workflow</title><desc id="rd-supervisor-worker-agents-desc">Runs Manual Trigger, then Supervisor, then Output. Supervisor Chat Model (echo) is attached to Supervisor as its chat model; Worker: Researcher is attached to Supervisor as its worker; Worker: Computer is attached to Supervisor as its worker; Researcher Chat (echo) is attached to Worker: Researcher as its chat model; MCP: lookup_kb is attached to Worker: Researcher as its tool; Computer Chat (echo) is attached to Worker: Computer as its chat model; MCP: calculator is attached to Worker: Computer as its tool; MCP: get_current_time is attached to Worker: Computer as its tool.</desc><defs><marker id="rd-supervisor-worker-agents-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M270 267 C314 267 314 267 358 267" marker-end="url(#rd-supervisor-worker-agents-arrow)"/><path class="rd-edge" d="M550 267 C634 267 634 267 718 267" marker-end="url(#rd-supervisor-worker-agents-arrow)"/><path class="rd-edge is-port" d="M455 240 C455 187 455 187 455 134"/><path class="rd-edge is-port" d="M455 294 C455 337 755 337 755 380"/><path class="rd-edge is-port" d="M455 240 C455 197 755 197 755 154"/><path class="rd-edge is-port" d="M755 434 C755 487 755 487 755 540"/><path class="rd-edge is-port" d="M755 434 C755 487 955 487 955 540"/><path class="rd-edge is-port" d="M850 127 C855 127 855 127 860 127"/><path class="rd-edge is-port" d="M850 127 C955 127 955 87 1060 87"/><path class="rd-edge is-port" d="M755 154 C755 157 1155 157 1155 160"/><g class="rd-node" data-kind="step" transform="translate(80 240)"><title>Manual Trigger (manual_trigger)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Manual Trigger</text><text class="rd-type" x="12" y="40">manual_trigger</text></g><g class="rd-node" data-kind="agent" transform="translate(360 240)"><title>Supervisor (supervisor_node)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Supervisor</text><text class="rd-type" x="12" y="40">supervisor_node</text></g><g class="rd-node" data-kind="model" transform="translate(360 80)"><title>Supervisor Chat Model (echo) (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Supervisor Chat Model (…</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="agent" transform="translate(660 380)"><title>Worker: Researcher (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Worker: Researcher</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(660 540)"><title>Researcher Chat (echo) (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Researcher Chat (echo)</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="tool" transform="translate(860 540)"><title>MCP: lookup_kb (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: lookup_kb</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="agent" transform="translate(660 100)"><title>Worker: Computer (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Worker: Computer</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(860 100)"><title>Computer Chat (echo) (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Computer Chat (echo)</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="tool" transform="translate(1060 60)"><title>MCP: calculator (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: calculator</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="tool" transform="translate(1060 160)"><title>MCP: get_current_time (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: get_current_time</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="step" transform="translate(720 240)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Manual Trigger | [`manual_trigger`](/nodes/reference/input#manual-trigger-—-manual-trigger) | Step in the run |
| Supervisor | [`supervisor_node`](/nodes/reference/agent#supervisor-node-—-supervisor-node) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Supervisor Chat Model (echo) | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Supervisor on its `chat_model` port |
| Worker: Researcher | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Attached to Supervisor on its `worker` port |
| Researcher Chat (echo) | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Worker: Researcher on its `chat_model` port |
| MCP: lookup_kb | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Worker: Researcher on its `tool` port |
| Worker: Computer | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Attached to Supervisor on its `worker` port |
| Computer Chat (echo) | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Worker: Computer on its `chat_model` port |
| MCP: calculator | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Worker: Computer on its `tool` port |
| MCP: get_current_time | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Worker: Computer on its `tool` port |

6 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Make it yours

- Give each worker its own real chat model on its `chat_model` port: a small, cheap model often does for a narrow worker.
- Swap a worker's mock tools for your own MCP servers.
- Add a third worker on the Supervisor's `worker` port when a new kind of task appears, rather than giving one agent every tool.

## Make it safer

These controls are optional; the recipe runs without them.

- Keep write tools on one worker only, and require approval for them: see [human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls).
- Record a good run as a [golden run](/product/golden-runs) and replay it after each change.

## Further reading

- [Agent loop: attachment ports](/runtime/agent-loop#attachment-ports)
- [Pattern library](/patterns/)
