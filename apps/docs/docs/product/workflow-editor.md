---
title: "Workflow editor: palette, connections and validation"
description: "The L2M visual workflow editor: the node palette, connections, node configuration, run data on the canvas and in the node inspector, import and export, flow patterns, validation."
---

# Workflow Editor

Concepts: [Workflows vs agents](/learn/agents/workflows-vs-agents) explains when to use fixed steps and when to let an agent decide.

## Core editor capabilities

- Drag/drop node palette
- Node-to-node edge connections
- Curved edges
- Node configuration via modal
- Node delete (`Delete` key)
- Save/import/export workflows
- Execution logs pane and run-inputs pane
- Per-node run data on the canvas and in the node inspector (see [Run data](#run-data))
- Agent port `+` buttons that open filtered drawers for Language Models, Memory, Tools, and Workers

## Run data

Run a workflow from the editor with **Debug** on (the default) and the canvas shows that run on every node, with
nothing to open:

- **Status, items and duration**: for example `success · 3 items · 28 ms`. Nodes that did not run say `skipped`;
  a node whose pinned data was reused says `pinned data`.
- **Out**: the first values of the node's output (result and text fields first), not just its field names.
- **Err** and a suggested fix when the node failed.
- Nodes attached to an agent port (chat model, memory, tool, worker, rules, protection) are not steps of the run.
  They show `used by <agent> as its <port>` instead; the data they handled is on the agent.

While the run is going the cards update live (running time, the step a node is on, streamed model text).

### The node inspector

Open a node to see the data of that run. With run data, the inspector opens on **Output**. **Split** shows
**Input | Parameters | Output** side by side (the default on wide windows when the node ran); the choice is
remembered in this browser.

- **Input** is what the node received: one section per upstream node (**From** and the node's name), then any other fields in
  scope (run input, input mapping). The run context (the editor's prompt fields, variables, webhook body, trigger) is
  folded away underneath: it is the same for every node of the run.
- **Output** shows the status line, then the data as a **Table** (lists become rows and columns), **JSON** or
  **Schema**. On an error it shows the error and the input the node failed on.
- Large values stay fast: tables show 50 rows at a time and JSON over 20,000 characters is cut until you ask for all
  of it.
- Data that did not come from a run is labelled: pinned data says **Pinned data, not from a run**, and a code
  node's test result says so too. With no run, the inspector says there is none.
- **Prev** and **Next** (or `Alt+[` and `Alt+]`) step through the nodes of the run in the order they started,
  without closing the inspector. Unsaved edits are kept or confirmed first.

### Picking a run

**Run data** in the canvas toolbar lists this workflow's latest runs. Pick one to load it onto the canvas and into
the inspector; the workflow itself is not changed. A run started elsewhere (a webhook, the API) appears on the canvas
on its own while it is running.

The editor shows exactly what run history stored for that run: it never fetches anything else. Values that run
history keeps masked or as placeholders (see [content rules](/product/content-rules)) stay that way here.

## Typical flow patterns

1. Basic LLM:
   - `text_input -> prompt_template -> ollama_chat_model -> output`
2. Agentic tool loop:
   - `webhook_input -> agent_orchestrator -> output`
   - Attachments:
     - `chat_model`: any Chat Model node, including OpenAI, Anthropic, Ollama, OpenAI Compatible, AI Gateway, Azure OpenAI, Gemini, or legacy `llm_call`
     - `memory`: `local_memory`
     - `tool`: one or more `mcp_tool` or `workflow_tool` nodes
3. RAG:
   - `text_input -> rag_retrieve -> prompt_template -> llm_call -> output`

## Validation behavior

Validation checks include:

- Graph structure and required edges
- Required node config fields
- Attachment-type correctness (for agent/supervisor ports)
- Node-type specific rules

Non-connected nodes are not executed.
