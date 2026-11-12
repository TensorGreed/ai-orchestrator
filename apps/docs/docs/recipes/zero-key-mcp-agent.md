---
title: "Build an MCP agent with no API key in 5 minutes"
description: "Import a ready MCP agent that runs on a fresh L2M install with a built-in echo model and a mock MCP server, then swap in a real model and server."
keys: "none"
keysNote: "No API key"
tags: ["agent","mcp","starter"]
nodeCount: 6
sample: "mcp-agent-quickstart-flow.json"
demo: "wf-mcp-agent-quickstart"
demoRecorded: true
related: ["agent-loop","tool-calling","ai-agent","mcp-tool"]
---

<!--
  Generated from samples/workflows/mcp-agent-quickstart-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Build an MCP agent with no API key in 5 minutes

**What you get:** One agent with a chat model and two MCP tools, a clock and a calculator, that runs on a fresh install.

**Needs:** No API key · **Time:** 5 minutes · **Nodes:** 6

A manual trigger starts one Agent Orchestrator node, which can call two tools from the bundled mock MCP server: `get_current_time` and `calculator`. The chat model is the built-in echo provider, so the workflow imports and runs with no key. Echo is not a real model: it never asks for a tool, so a local run ends after one model call. To watch the full loop, with its tool calls, play the recorded run in the demo, or attach a real chat model.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/mcp-agent-quickstart-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-mcp-agent-quickstart&amp;demoRun=recorded" target="_self">Open it in the demo and play a run</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/mcp-agent-quickstart-flow.json" download>mcp-agent-quickstart-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/mcp-agent-quickstart-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Run it as it is and open the run to see each step.
4. Then change one thing at a time (see below).

## How it works

<figure class="recipe-diagram">
<svg viewBox="56 176 878 382" role="img" aria-labelledby="rd-zero-key-mcp-agent-title rd-zero-key-mcp-agent-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-zero-key-mcp-agent-title">Diagram of the MCP Agent Quickstart workflow</title><desc id="rd-zero-key-mcp-agent-desc">Runs Manual Trigger, then Agent, then Output. Chat Model (echo) is attached to Agent as its chat model; MCP: get_current_time is attached to Agent as its tool; MCP: calculator is attached to Agent as its tool.</desc><defs><marker id="rd-zero-key-mcp-agent-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M270 227 C324 227 324 227 378 227" marker-end="url(#rd-zero-key-mcp-agent-arrow)"/><path class="rd-edge" d="M570 227 C644 227 644 227 718 227" marker-end="url(#rd-zero-key-mcp-agent-arrow)"/><path class="rd-edge is-port" d="M475 254 C475 317 535 317 535 380"/><path class="rd-edge is-port" d="M475 254 C475 307 755 307 755 360"/><path class="rd-edge is-port" d="M475 254 C475 367 755 367 755 480"/><g class="rd-node" data-kind="step" transform="translate(80 200)"><title>Manual Trigger (manual_trigger)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Manual Trigger</text><text class="rd-type" x="12" y="40">manual_trigger</text></g><g class="rd-node" data-kind="agent" transform="translate(380 200)"><title>Agent (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Agent</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(440 380)"><title>Chat Model (echo) (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat Model (echo)</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="tool" transform="translate(660 360)"><title>MCP: get_current_time (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: get_current_time</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="tool" transform="translate(660 480)"><title>MCP: calculator (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: calculator</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="step" transform="translate(720 200)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Manual Trigger | [`manual_trigger`](/nodes/reference/input#manual-trigger-—-manual-trigger) | Step in the run |
| Agent | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Chat Model (echo) | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Agent on its `chat_model` port |
| MCP: get_current_time | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent on its `tool` port |
| MCP: calculator | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent on its `tool` port |

5 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Make it yours

- Replace the echo chat model node with a real one (OpenAI, Anthropic, Ollama or any OpenAI-compatible endpoint) on the agent's `chat_model` port.
- Replace the mock MCP tools with a server from your [MCP server registry](/product/mcp-server-registry), such as a filesystem or database server.
- Write your own system prompt on the agent node, and raise `maxIterations` only if the task needs more steps.

## Make it safer

These controls are optional; the recipe runs without them.

- Deny or allow tools per role with [MCP tool policy](/product/mcp-tool-policy).
- Require a person's approval before write tools run: see [human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls).
- Cap model spend with a [budget](/product/budgets).

## Further reading

- [Build your first MCP agent in 5 minutes](/getting-started/build-your-first-mcp-agent)
- [What is an AI agent?](/learn/agents/what-is-an-ai-agent)
- [Agent loop](/runtime/agent-loop)
- [Pattern library](/patterns/)
