---
title: "Workflow editor: palette, connections and validation"
description: "The L2M workflow editor: node palette, connections, node configuration, run data on the canvas and in the inspector, import and export, validation."
---

# Workflow Editor

Concepts: [Workflows vs agents](/learn/agents/workflows-vs-agents) explains when to use fixed steps and when to let an agent decide.

## Core editor capabilities

- Drag/drop node palette
- Node-to-node edge connections
- Curved edges
- Node configuration in the docked inspector
- Node delete (`Delete` key)
- Save/import/export workflows
- Execution logs pane and run-inputs pane
- Per-node run data on the canvas and in the node inspector (see [Run data](#run-data))
- Agent port `+` buttons that open filtered drawers for Language Models, Memory, Tools, and Workers

## Workflow settings

The **⋯** menu in the editor's top bar holds the settings of the whole workflow (they are saved with it):
**No write tools**, **Ask before write tools…**, **Subject references…** and **Error workflow…**. A tick shows the ones
that are on.

**Error workflow…** picks another workflow of the project that starts when a run of this one fails, for alerts or
clean-up (`settings.errorWorkflowId` in the workflow JSON). Start it with an **Error Trigger**, which outputs the failed
run's `source_workflow_id`, `source_workflow_name`, `execution_id`, `error`, `error_stack` and `timestamp`. The failed
run's caller still gets the error, replays never start it, and an error workflow in another project runs only when
that project shared it with execute access (see [what a running workflow can reach](../security/auth-rbac.md#what-a-running-workflow-can-reach)). Pick **None** to turn it
off.

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

Double-click a node to open it. The inspector opens as a panel over the dimmed editor; click the dimmed area, press
`Esc` or use the close button to return to the canvas (unsaved edits are confirmed first). On a wide window the
inspector shows **Input | Parameters | Output** side by side,
for every node, so it keeps its shape while you move between nodes; on a narrow window the same parts are tabs
(the layout button in the header switches between the two, and the choice is remembered in this browser).

- **The header** holds the node's name (edit it in place), its type and node id, the node's run
  status with its item count and duration, **Previous** / **Next** step buttons and **Run node**. The status shows
  only here.
- **Input** is what the node received: one section per upstream node (**From** and the node's name), then the run's own
  input fields. What the node resolved in this run and the run context (the editor's prompt fields, variables,
  webhook body, trigger) are folded away underneath: the run context is the same for every node of the run.
- **Output** shows the data, or the error with a suggested fix when the node failed (in the tab layout the input it
  failed on is repeated under it).
- Each data pane has one **Table / JSON** switch. Its **⋯** menu holds the **Schema** view, **Show internal fields**
  (the run's own bookkeeping fields, such as `_telemetry` and `_branchHandle`, are left out of tables until you ask;
  JSON always shows them; your data's own fields, such as `_id`, always show) and, on Output, **Pin output** /
  **Unpin output**.
- Hide a data pane with the arrow in its header (it becomes a thin rail; click it to bring the pane back) and drag the
  line between panes, or focus it and use the arrow keys, to resize. Both are remembered. The panes give way when the
  window is narrow, so the parameters and the Output pane stay in view. Before a node has run, its empty Input and
  Output panes start as rails so the parameters get the room.
- **Parameters** shows the fields you set most. A node type's rarely used fields (for example an HTTP request's
  headers, body and timeout, a model's temperature and max tokens, an agent's iteration and tool output limits, a
  content rules node's approval settings) are under **Advanced**, closed by default; its title counts the fields
  that differ from their defaults. Help for a field is behind the **?** next to its label. The expression helpers
  under a template field show while you edit it, and its preview shows when the result differs from what you typed
  (or the expression has an error). A code node's **Test Run** stays in view, with its test input folded under it.
- **Settings** holds what every node has: disabled, accent colour, error handling (retries, delay, on error), input
  mapping and data labels. A dot on the tab means one of them differs from the default.
- **Trace** shows timing, token use, the agent's activity and tool policy decisions for the run.
- Large values stay fast: tables show 50 rows at a time and JSON over 20,000 characters is cut until you ask for all
  of it. A nested object or list in a table cell whose JSON is longer than 80 characters shows as one line (its first
  keys and short values, or a list's length and first items); click it to open the full value as JSON.
- Data that did not come from a run is labelled: pinned data says **Pinned data, not from a run**, and a code
  node's test result says so too. With no run, the inspector says there is none.
- **Previous** and **Next** (or `Alt+[` and `Alt+]`) step through the nodes of the run in the order they started,
  without closing the inspector. Unsaved edits are kept or confirmed first.

### Picking a run

**Run data** in the canvas toolbar lists this workflow's latest runs. Pick one to load it onto the canvas and into
the inspector; the workflow itself is not changed. An older run stays loaded until you pick the latest one or run
the workflow again. Otherwise a run started elsewhere (a webhook, the API) appears on the canvas on its own while it is
running.

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
