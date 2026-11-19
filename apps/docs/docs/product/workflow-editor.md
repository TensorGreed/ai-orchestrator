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
- One undo history for every canvas change (see [Undo and redo](#undo-and-redo))

## Adding nodes

Open the palette with **Add node**, a double-click on empty canvas, or the `+` beside a node's output.

- **Search** ranks what you type: an exact node name first (`output` finds **Output**, `if` finds **IF**), then names
  that start with it, then other names a node goes by (`api` or `fetch` find **HTTP Request**, `foreach` finds
  **Loop / ForEach**), then words in the description. The top result is marked **Best match**; **Enter** adds the
  highlighted row and the arrow keys move the highlight.
- **After the selected node**: with one node selected, the node you pick is placed to its right, clear of other
  nodes, and connected from its first output that has no connection yet. The new node is selected, so adding several
  in a row builds a chain. The palette's subtitle names the node it connects after. A trigger or input node, a sticky
  note, and a model, memory or tool picked after an agent are placed but not connected (attach those through the
  agent's ports). The connection follows the same rules as one you drag: when they refuse it (for example a model
  picked before an agent), the node is placed unconnected and the editor shows why.
- **From an output**: the `+` beside an output (shown on outputs with no connection, and on hover) opens the palette
  connected after that output, for example an IF node's **false** branch or a node's red **Error** output (a node
  added after an Error output goes on the row below). Dragging a connection out of an output and
  dropping it on empty canvas does the same, and places the node where you dropped it.
- **Drag and drop** a palette row onto the canvas to place a node at that point without connecting it.

The canvas pans to show a node it adds when the node would land out of view.

## Undo and redo

`Ctrl+Z` undoes the last canvas change and `Ctrl+Shift+Z` or `Ctrl+Y` redoes it (`Cmd` on macOS). Every change is
one step: adding, deleting, moving (one step per drag), connecting and removing a connection (double-click or
right-click an edge), **Clear**, paste, duplicate, a node's settings, and **Tidy**. **Clear** asks before it removes
the nodes, and can be undone. Opening or reloading a workflow starts a fresh history.

## Model nodes

A new **LLM Call** starts on a model that works right away. When the API server's environment sets `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`
(checked in that order), the node starts on that provider; otherwise, when you have saved a secret for OpenAI,
Anthropic or Gemini, it starts on that provider with that secret; otherwise it starts on **Echo**, the built-in demo
model. Echo answers with the prompt it receives, needs no key and calls nothing, so a new workflow runs on the first
try. Pick a real provider in the node's **Provider** list when you are ready. A local Ollama is never picked for you.
Nodes you already have keep the model they name.

A new chain node such as **Text Classifier** or **Summarization Chain** starts with its **Provider** "Not set": it uses
the model of an upstream model node. Pick a provider to give it its own model, or **Not set** to go back.

Opening a model node never contacts a model server. To pick from the models a provider offers, click **Load models**
under the model field; until then, type the model name. Model lists for Ollama come only from the node's base URL or
the server's `OLLAMA_BASE_URL`.

The agent's **Language Models** drawer offers **LLM Call** too, so an agent can run on Echo before it has a real model.

## Workflow settings

The **⋯** menu in the editor's top bar holds the settings of the whole workflow (they are saved with it), under
**More settings**: **No write tools**, **Strict templates**, **Ask before write tools…**, **Subject references…** and
**Error workflow…**. Most workflows leave them as they are. **More settings** says how many are on, and a tick shows
which.

**Strict templates** makes a <span v-pre>`{{ }}`</span> without a value fail its node instead of rendering empty
(`settings.strictTemplates`; off by default). See [strict templates](../runtime/templates-and-expressions.md#strict-templates).

**Error workflow…** picks another workflow of the project that starts when a run of this one fails, for alerts or
clean-up (`settings.errorWorkflowId` in the workflow JSON). Start it with an **Error Trigger**, which outputs the failed
run's `source_workflow_id`, `source_workflow_name`, `execution_id`, `error`, `error_stack` and `timestamp`. The failed
run's caller still gets the error, replays never start it, and an error workflow in another project runs only when
that project shared it with execute access (see [what a running workflow can reach](../security/auth-rbac.md#what-a-running-workflow-can-reach)). Pick **None** to turn it
off.

## Running from the editor

**Run workflow** runs the saved workflow. The editor has a built-in test prompt, "What time is it in America/Toronto?
Use tools when needed.", with the system prompt "You are a precise tool-using AI assistant.", and sends each one as the
run's `user_prompt` and `system_prompt` only when the workflow can read it:

- a model, chain, Azure OpenAI Embeddings, Agent or Supervisor node, which falls back to the run's prompts;
- a Text Input, User Prompt or Chat Trigger node (`user_prompt`), or a System Prompt node with no text
  (`system_prompt`);
- a Prompt Template, RAG Retrieve, Rerank or Chat Intent Router node that keeps its default `{{user_prompt}}`
  template;
- any node setting that names `user_prompt` or `system_prompt`, such as a `{{user_prompt}}` template or an input
  mapping that reads one.

A Text Input or User Prompt node with text keeps the test prompt out, so the node's text is used, and a System
Prompt node with text does the same for the system prompt. A workflow that reads neither, for example an HTTP
Request followed by an Output, runs with no prompt, so the test prompt does not show up in its input or its output.
The chat panel sends the message you type, and its system prompt on the same rule.

**Webhook run** (canvas toolbar) asks for the request body first: a JSON object that the run receives as a call to the
webhook URL would send it, so nodes read its fields as <span v-pre>`{{webhook.customer}}`</span>. The body is saved with the workflow
(`settings.testWebhookPayload`, at most 64 KB) and filled in the next time. Everyone who can read the workflow sees it,
so a field named like a credential (`password`, `token`, `api_key`, `authorization`, `secret` and the like) is refused:
put credentials in a secret instead.

**New workflow** opens a User Prompt → Output starter in the editor without saving it. Its first edit (or a save or a
run) saves it; open another workflow first and nothing is kept.

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
- **Parameters** shows the fields a first workflow needs. Everything else sits in one **More** section at the end of
  the form, closed by default: first the node type's rarely used fields (for example a GET request's headers, an HTTP
  request's timeout, response type and retried statuses, a Loop's item variable and maximum, a Filter's **Items
  from**, a model's temperature and max tokens, an agent's iteration and tool output limits, a content rules node's
  approval settings), then what every node has: error handling (retries, delays, on error), input mapping, data
  labels, **Disabled** and the accent colour. Its title counts the settings that differ from their defaults, and it
  opens by itself when one of them needs fixing. A POST, PUT or PATCH request shows its **Body** and **Headers** next to the URL; a
  body that is valid JSON is sent as `application/json` unless the headers set a `Content-Type`. Help for a field is
  behind the **?** next to its label. The expression helpers
  under a template field show while you edit it, and its preview shows when the result differs from what you typed
  (or the expression has an error). Typing <span v-pre>`{{`</span> in a template field lists the last run's fields, variables and steps
  to insert, and a field name dragged from the **Input** pane inserts its <span v-pre>`{{path}}`</span>; a note under the field names
  any <span v-pre>`{{ }}`</span> the last run had no value for (see [writing templates in the editor](../runtime/templates-and-expressions.md#writing-templates-in-the-editor)). A code node's **Test Run** stays in view, with its test input folded under it.
- **A node saved with an earlier behaviour** shows the switch for it, with a one-line note and **Upgrade to the new
  behaviour** (until you save, **Keep the earlier behaviour** takes the upgrade back). New nodes start on the new
  behaviour and show neither. This covers a Loop's **Collect results** and **Branches route in the loop**, an HTTP
  Request's **Fail on HTTP error status**, a Filter's **Pass or stop** mode and a Set field's **Text (as before)**
  type. Nothing changes for a saved node until you upgrade it.
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
running. Opening a workflow loads its latest run, so the run pill and Run data show it straight away; **Clear logs**
keeps the canvas clear until the next run.

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

An Output node is optional. Without one, a run's result is the output of the last node that ran, and validation
lists it as a note, not an error.

Saving keeps a draft: node settings you have not filled in yet (an HTTP Request URL, an IF condition, a model, a
Set node's fields and the like) do not stop a save. The editor lists them above the canvas after the save, with a
link to each node, and a run stops at them until they are fixed. Such a version cannot be published either. A save is
still refused for a broken graph (a cycle, an edge to a missing node, a repeated node id) and for settings that are
live as soon as the workflow is saved: trigger and webhook authentication settings, approval and content-rule rules,
and attachment rules.

### Settings that may be unfinished in a draft

These save unfinished; each one stops a run until it is filled in:

- Templates: a Prompt Template's template, an HTTP Request URL and its Retry on status list, a Set node's fields (and
  their names and values)
- Branching: an IF condition, a Switch value and its cases, a Merge node's combine key and its second input
- Loops: a Loop's input key and item variable
- Models: an LLM Call's provider, a Gemini model, a chat model's model or gateway base URL, an agent's attached chat
  model
- Azure: the Azure OpenAI secret, endpoint and deployment, the Azure embedding secret and settings, and the
  operation of an Azure Storage, Monitor, Cosmos DB or AI Search node
- Tools and data: an MCP tool or resource, a connector, a Qdrant operation, an output parser's schema, an input
  validator's rules
- Code and sub-workflows: a code node's script, the workflow an Execute Workflow or Workflow Tool node calls

### Live triggers of an unfinished draft

While the version production would run has unfinished settings (a saved draft with nothing published), its live
triggers are paused and the editor says so above the canvas: a production webhook (`/webhook/:path`, after its own
address and authentication checks), form submission, chat message or MCP trigger call answers `409` with
`code: "workflow_unfinished"` and starts no run (the form page and the tool's manifest still show), and a schedule or
app trigger skips its tick. Other production runs of that version are refused with the same code: an API key's
`/execute` answers `409`; a sub-workflow call fails the calling run with `errorCode: "workflow_unfinished"` (a webhook
answer carries it as `code`); a call through the MCP gateway returns a tool error with `_meta.code`. The audit log
records the pause once per version (`workflow.triggers_paused`, "Live triggers paused: unfinished settings"). Webhook run and the test webhook URL (`/webhook-test/:path`) still run the draft, so you can
see where it stops. Save it finished and the triggers serve again.

Non-connected nodes are not executed.
