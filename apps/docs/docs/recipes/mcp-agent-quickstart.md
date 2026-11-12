---
title: "MCP agent quickstart: an agent with two MCP tools"
description: "A ready-to-import L2M workflow: one agent with a chat model and two MCP tools, a clock and a calculator. Runs without API keys on a fresh install."
tags: ["agent","mcp","starter"]
nodeCount: 6
sample: "mcp-agent-quickstart-flow.json"
demo: "wf-mcp-agent-quickstart"
demoRecorded: true
related: ["agent-loop","tool-call"]
---

<!--
  Generated from samples/workflows/mcp-agent-quickstart-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# MCP agent quickstart: an agent with two MCP tools

The smallest useful agent: a manual trigger starts one Agent Orchestrator node, which answers with the help of two MCP tools from the bundled mock MCP server, `get_current_time` and `calculator`. The chat model is the built-in echo provider, so it runs with no API key. Use it to see the agent loop and its tool calls, then swap the echo provider for a real model and the mock server for your own MCP server.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/mcp-agent-quickstart-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&workflowId=wf-mcp-agent-quickstart&demoRun=recorded" target="_self">Open it in the demo and play a run</a>
</div>

## Workflow

<figure class="recipe-diagram">
<svg viewBox="56 176 878 382" role="img" aria-labelledby="rd-mcp-agent-quickstart-title rd-mcp-agent-quickstart-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-mcp-agent-quickstart-title">Diagram of the MCP Agent Quickstart workflow</title><desc id="rd-mcp-agent-quickstart-desc">Runs Manual Trigger, then Agent, then Output. Chat Model (echo) is attached to Agent as its chat model; MCP: get_current_time is attached to Agent as its tool; MCP: calculator is attached to Agent as its tool.</desc><defs><marker id="rd-mcp-agent-quickstart-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M270 227 C324 227 324 227 378 227" marker-end="url(#rd-mcp-agent-quickstart-arrow)"/><path class="rd-edge" d="M570 227 C644 227 644 227 718 227" marker-end="url(#rd-mcp-agent-quickstart-arrow)"/><path class="rd-edge is-port" d="M475 254 C475 317 535 317 535 380"/><path class="rd-edge is-port" d="M475 254 C475 307 755 307 755 360"/><path class="rd-edge is-port" d="M475 254 C475 367 755 367 755 480"/><g class="rd-node" data-kind="step" transform="translate(80 200)"><title>Manual Trigger (manual_trigger)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Manual Trigger</text><text class="rd-type" x="12" y="40">manual_trigger</text></g><g class="rd-node" data-kind="agent" transform="translate(380 200)"><title>Agent (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Agent</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(440 380)"><title>Chat Model (echo) (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat Model (echo)</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="tool" transform="translate(660 360)"><title>MCP: get_current_time (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: get_current_time</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="tool" transform="translate(660 480)"><title>MCP: calculator (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: calculator</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="step" transform="translate(720 200)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

## Nodes

| Node | Type | Role |
| --- | --- | --- |
| Manual Trigger | [`manual_trigger`](/nodes/reference/input#manual-trigger-—-manual-trigger) | Step in the run |
| Agent | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Chat Model (echo) | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Agent on its `chat_model` port |
| MCP: get_current_time | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent on its `tool` port |
| MCP: calculator | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent on its `tool` port |

5 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Use it

1. Download <a href="/docs/recipes/files/mcp-agent-quickstart-flow.json" download>mcp-agent-quickstart-flow.json</a>.
2. Import it in the studio's workflow editor (see [import and export](/product/workflow-editor)).
3. Run it as it is, then change one node at a time: a real chat model, your own MCP server, your own prompts.

## Further reading

- [Build your first MCP agent in 5 min](/getting-started/build-your-first-mcp-agent)
- [Agent loop](/runtime/agent-loop)
- [Pattern library](/patterns/)
