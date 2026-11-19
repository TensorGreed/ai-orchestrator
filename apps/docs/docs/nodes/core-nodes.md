---
title: "Core nodes: inputs, LLM, agents, RAG and outputs"
description: "The core L2M nodes by group: inputs, prompting, LLM and agent, MCP tools, RAG and data, utilities and outputs, plus execution notes and the Output Parser."
---

# Core Nodes

The nodes most workflows are built from, by their type id (the `type` in workflow JSON). Every node, with its
fields, is in the [node reference](./reference/index.md). [Templates and expressions](/runtime/templates-and-expressions)
covers what a templated field can read from earlier steps.

## Input

- `webhook_input`
- `manual_trigger`
- `schedule_trigger`
- `chat_trigger`
- `text_input`
- `system_prompt`
- `user_prompt`

## Prompting

- `prompt_template`

## LLM / Agent

- `llm_call`
- `agent_orchestrator`
- `supervisor_node`

## MCP / Tools

- `mcp_tool`
- `workflow_tool` (another workflow as an agent's tool)

## RAG / Data

- `rag_retrieve`
- `connector_source`

## Flow control

- `if_node`
- `switch_node`
- `filter_node` (see [Lists of items](#lists-of-items))
- `loop_node`
- `merge_node`
- `approval_gate`

## Utilities

- `set_node` (Set / Transform, see [Lists of items](#lists-of-items))
- `local_memory` (Simple Memory)
- `output_parser`
- `http_request`
- `code_node`
- `pdf_output`
- `chart` ([Chart node](/nodes/chart): Vega-Lite specs to SVG)
- `execute_workflow`

## Output

- `output`

## Notes on execution

- Disconnected nodes are skipped.
- IF nodes take the `true` or `false` branch; Switch nodes route branches by evaluated case. Branches not taken are
  skipped.
- An IF condition that is one template (<span v-pre>`{{answer}}`</span>, <span v-pre>`{{ score > 90 }}`</span>) is rendered and is false when the text is
  empty, `false`, `0`, `null` or `undefined`, true otherwise. A condition with text outside its braces
  (<span v-pre>`{{score}} > 90`</span>, <span v-pre>`{{status}} === 'done'`</span>) is one JavaScript expression in the sandbox: each <span v-pre>`{{ }}`</span> is replaced by
  its value (numbers stay numbers, text stays text, a missing value is `undefined`). Quote text you compare with; a
  condition that fails once filled in (not a valid expression, an error while it runs, a timeout) fails the node with
  an error that names the condition and the kind of error, never the values.
- Nodes on an agent's attachment ports (`chat_model`, `memory`, `tool`, `worker`) are not DAG steps: the agent uses
  them when it runs.
- Node execution status is persisted in execution history.

## Lists of items

A step passes one object to the next. A list inside it (`products`, an HTTP response's `body.items`) is a list of
items, and four nodes work on such lists.

### Filter

**Mode** picks what a Filter does:

- **Keep matching items of a list** (`mode: "items"`, the default for new Filters). Each item of a list is checked
  against the conditions, and the output is `items` (the items that match), `count`, `rejected` (the others),
  `rejected_count`, `total` and `items_from` (the list's path). **Items from** names the list (`body.items`, or
  <span v-pre>`{{ body.items }}`</span>); empty means the first list in the input, top-level fields before nested
  ones, up to three levels deep. An input without a list is filtered as one item. A condition's field is read from
  the item (`price`, `item.price` or `$json.price`). A field the item does not have is missing; it is not read from
  the node's input, except a path that starts at a template root (`results.<id>.…`, `vars.…`, `webhook.…`) or at a
  run value such as a Loop's item variable. A condition's value can use <span v-pre>`{{item.field}}`</span> and the
  item's fields, which never replace `results`, `vars` and the other roots. Inside a loop body, `item` is the
  Filter's item: give the Loop another **Item variable** (`product`) to read the loop's item there.
- **Pass or stop** (`mode: "gate"`). The conditions judge the whole input once: the output is the input plus
  `passed`. A Filter saved before modes existed (no `mode`) works this way.

The Filter has two outputs, with the same handles in both modes (changing the mode keeps the edges):

| Output (handle) | Keep matching items | Pass or stop |
|---|---|---|
| First (`pass`) | **Kept**: runs when at least one item matches, with the Filter's output (`items` holds the matches). | **Pass**: runs when the input matches. |
| Second (`filtered`) | **Rejected**: runs when at least one item does not match. The next node receives the rejected items as `items` (with `count`, `total` and `items_from`). | **Stopped**: runs when the input does not match, with the input. |

With a list that is empty, neither output runs. An edge saved before the Filter had two outputs has no handle: the
editor draws it from the first output, and it still runs whatever the Filter decides, as it did before. Reconnect it
to Pass or Kept to make it follow the Filter. A node such an edge reaches runs even when a skipped output also leads
to it. Inside a Loop body the outputs route on each pass when the Loop has **Branches route in the loop** on (see
[Loop and Merge](#loop-and-merge)). A Filter imported from another builder uses Pass or stop, its kept output
on Pass and its discarded output on Stopped.

### Set / Transform

Each field has a **Type** (`type`). A field on `auto` keeps its type under **More** (**Type of** the field's key); a
field with another type shows it in its row.

| Type | The value |
|---|---|
| `auto` (new fields) | A value that is one <span v-pre>`{{ }}`</span> keeps its type: <span v-pre>`{{ item.price > 25 }}`</span> is `true` or `false`, <span v-pre>`{{ count }}`</span> a number, a list stays a list. Other values are text, and text that is a JSON object or list is parsed. A missing value is `null`. |
| `string` | Text. An object or list is written as JSON text. |
| `number` | A number. Text that is not a number fails the node. |
| `boolean` | `true` or `false` (also from `yes`/`no`, `1`/`0`, `on`/`off`). Other text fails the node. |
| `json` | Text is parsed as JSON; a value of one <span v-pre>`{{ }}`</span> that is not text (a number, list or object) is kept as it is. Text that is not JSON fails the node. |

An empty value is `null` for `number`, `boolean` and `json`. A field saved before types existed has no type and is
shown as **Text (as before)**: its value becomes text, and text that is a JSON object or list is parsed, so
<span v-pre>`{{ item.price > 25 }}`</span> gives the text `"true"`. Choose a type to change that.

### Loop and Merge

See [Loops](/runtime/templates-and-expressions#loops): **Collect results** on a Loop adds `collected` (one entry per
pass), and a Merge in **Collect loop passes** mode (`collect_loop_passes`) gathers every pass of the loop body node
connected into it. That Merge needs only the one incoming edge.

#### Branches in a Loop body

With **Branches route in the loop** on (`routeBranches`, on for new Loops), an IF, Switch or Filter in the loop body
works as it does elsewhere, once per item:

- On each pass, only the outputs it takes run. The nodes on the other outputs are skipped for that pass.
- The nodes connected to its outputs are part of the body, so they run once per item too. The same holds for the
  outputs of a Content Rules or Chat Intent Router node in the body. A node joins the body this way only when all of
  its incoming connections come from the Loop or from body nodes. Other nodes after the body run once, after the
  loop. That includes a node on a body IF's output that also has a connection from outside the loop: it runs once,
  after the loop, whichever outputs the passes took.
- A body node's own **On Error** setting applies, as elsewhere. **Continue Anyway** gives the next nodes of that pass
  `{ error }`. With **Execute Fallback Branch**, the nodes on its Error output run for that pass, and the loop goes
  on with the next item. The nodes on its other outputs are in the body too. **Stop Execution** (the default)
  fails the Loop.
- During a pass, `results.<id>` of a body node that pass skipped is empty. After the loop, a body node's result is
  the last pass that ran it.
- After the loop, a body node that no pass ran shows as skipped, and so do the nodes after it, unless a body node
  that ran also leads to them. A Loop with no items skips nothing.
- **Collect results** holds one entry per pass, read from the body's last nodes (the ones no other body node
  follows). With one last node, the entry is its output, or `null` on a pass that skipped it. With several, the entry
  holds the outputs of those that ran on the pass, by node id:
  <span v-pre>`{{results.<loopId>.collected.0.<nodeId>}}`</span>.
- A Merge in **Collect loop passes** mode with several body nodes connected in (the IF's two outputs, for example)
  gathers their outputs pass by pass, in item order.
- A Loop can sit in a Loop body. It runs all of its passes on each pass of the outer Loop.

```text
Loop ─► IF ─ true ─► Tag as large ─┐
          └─ false ─► Tag as small ─┴─► Merge (Collect loop passes)
```

A Loop saved before this option has it off. Then a branching node in the body does not choose which nodes run: the
nodes after every one of its outputs run once, after the loop, and a body node's own On Error is not used (a failure
fails the Loop). Turn the option on to make that Loop route; check what its later nodes read first, since the nodes
on the branching node's outputs then run once per item.

A **Human Approval** node in a body asks once per pass that reaches it. The run pauses, and the request shows the
item's message and the pass (**Pass 2 of 3**). After the decision, the run goes on in that pass at that node, then
with the later passes; nothing that ran before the approval runs again. A Loop of 3 items can ask 3 times, one
request after another.

- **Approve**: the pass goes on to the nodes after the approval.
- **Reject** or a timeout: in a Loop whose branches route, an approval whose On Error is **Execute Fallback Branch**
  sends that pass to its Error output, and the loop goes on with the next item. Otherwise the run stops, as it does
  for a rejection outside a Loop. **Continue Anyway** never continues past an approval, set on the approval or on
  the Loop.
- A Loop inside a Loop body pauses and resumes the same way.

An Approval Gate in a body is refused when you save. An approval an agent's tool gate or a sub-workflow asks for
inside a body fails the Loop. To ask once for all the items, put the approval before or after the Loop.

## Errors and retries

Every node has the same error settings, under **More** in its inspector.

### Retries

- **Retries on Failure** (`retryCount`) is how many times a failed node is tried again. `0` runs it once. Left unset,
  nodes that call a model, a tool or the network (LLM, agent, MCP Tool, HTTP Request, connectors) try once more after 2 s
  (3 s for agents); other nodes are not retried.
- **Delay between Retries** (`retryDelayMs`, default 1000) is the first wait. Each later wait doubles, and every wait
  is varied by up to 20% either way (jitter), so many runs retrying at once do not hit a server together.
- **Max delay between Retries** (`retryMaxDelayMs`, default 30000) caps each wait.
- When an HTTP server sends `Retry-After` (seconds or a date), the node waits at least that long. If it asks for longer
  than the max delay, the node fails at once and the error says so; raise the max delay to wait it out.
- Some failures are never retried: a refusal by content rules or a tool rule, a blocked URL, a model outside the
  allowlist, an approval decision, a spent quota, and an HTTP status that is not on the node's retry list.

### On Error

- **Stop Execution** (default) fails the run.
- **Continue Anyway** gives the next nodes `{ error }` as this node's output and goes on.
- **Execute Fallback Branch** gives the node a red **Error** output on the canvas (under a card's right edge, on an
  agent's right side). When the node fails, the nodes connected to it run and every other output of the node is
  skipped; when it succeeds, the Error output's nodes are skipped. The Error output carries the fields of the item the
  node failed on, plus `error` (the message), `errorCategory`, `failedNodeId`, `failedNodeType` and, for an HTTP status
  error, `status`. So a fallback step can use the same templates as the normal path, for example
  <span v-pre>`{{customer}}: {{error}}`</span>. The editor warns when the option is set and nothing is connected, and when
  something is connected but the option is not set. Try/Catch keeps its own Catch output; a node inside a Try/Catch
  whose own Error output is connected uses that output instead of the Catch. A Loop's Error output is not part of its
  body: it runs only when the loop fails. A node inside a loop body uses its own On Error setting when the Loop has
  **Branches route in the loop** on; in a Loop without it, a failure there fails the Loop (use the Loop's Error
  output). A replayed run (the release gate) gives a recorded failure's Error
  output only `error`, without `status` or the original `errorCategory`.
- A failure that was handled (sent to a connected Error output, caught by a Try/Catch, or passed on by **Continue
  Anyway**) does not fail the run: the node shows **handled** in amber, the run summary counts it as ok
  ("4 of 4 ok · 1 handled") and the run ends `success`. Its result keeps `status: "error"` with `handled: true`.
  A failure with nothing to handle it still fails the run.

### HTTP Request status codes

- **Fail on HTTP error status** (`failOnHttpError`): a status outside 200–299 fails the node, so retries and the Error
  output apply. The error names the status, the method and the URL (without user name, password, query or fragment).
  Off, the response is returned as before, with `status` and `ok: false`. New HTTP Request nodes have it on and do
  not show the switch; a node saved without it shows it with **Upgrade to the new behaviour**, and one set off shows it.
  `304 Not Modified` is not an error.
- **Retry on status** (`retryOnStatus`): the statuses that are retried, as codes (`503`), classes (`5xx`) or ranges
  (`500-504`). Empty means `429, 5xx`. Any other status fails at once, without retrying.
- An HTTP Request node saved before the option existed has no `failOnHttpError` and keeps returning the response
  with `ok: false`. If it asks for retries (Retries on Failure above 0, or retries in its `errorConfig`), the
  statuses on its retry list are retried and fail the node once the retries are spent; other error statuses are still
  returned. The editor says so on such a node. Turn the option on to fail on every error status, or off to never fail.
- A node's `errorConfig` in the workflow JSON (`retryOnFail`, `maxRetries`, `retryIntervalMs`, `continueOnFail`) is
  kept when the workflow is saved and takes precedence over the fields under More, which show it. A save
  refuses invalid values (a negative `maxRetries`, for example). A workflow stored with such values before saves
  checked them still runs, with the invalid fields ignored; the editor names them when the workflow is opened, and
  **Remove invalid values** under the node's More (which opens for it) removes them with the next save.
- Network failures and timeouts name the method and URL the same way and are retried as set under Retries on Failure.

### HTTP Request secrets

- A secret picked on the node (`secretRef`) is sent as `Authorization: Bearer <secret>`, as before.
- `secretAuth` sends it another way: `{ "type": "basic" }` (the secret holds `user:password`),
  `{ "type": "header", "name": "X-API-Key" }` or `{ "type": "query", "name": "api_key" }`. Nodes made from an API
  operation set it from the spec (see [Your integrations](./integrations.md)); a node without it is unchanged.
- A secret in its own header or in the query stays with the site: a redirect to another host fails the node. The
  query secret is never part of the URL in run logs or error messages.

## Output Parser (`output_parser`)

`output_parser` supports two independent controls:

- `mode`:
  - `json_schema`
  - `item_list`
  - `auto_fix`
- `parsingMode`:
  - `strict`
  - `lenient`
  - `anything_goes`

### Retries

In `json_schema` and `auto_fix` modes, output that does not parse is sent back to the upstream model with a request to
fix it, up to `maxRetries` times (**LLM Max Auto-Retries**, default 2). `0` makes no retry call: the node fails at once
(or, with `parsingMode: anything_goes`, returns `parsed: null` with a warning). A negative or non-numeric value uses
the default.

### `parsingMode` behavior

- `strict`: only valid JSON parses successfully.
- `lenient`: tries common repair steps (python literals, single quotes, trailing commas, unquoted keys).
- `anything_goes`: includes `lenient` and also best-effort parsing of simple `key: value` blocks.

### Input key behavior

`inputKey` accepts:

- path format: `debug.agent_answer`
- array path format: `messages[5].content`
- moustache path format: `&#123;&#123;debug.agent_answer&#125;&#125;`

### Runtime trace

When `mode` is `json_schema` or `auto_fix`, parser output includes:

- `parsed`
- `raw`
- `retries`
- `parserTrace`:
  - `strictness`
  - `strategy`
  - `confidence`
  - `candidateCount`
  - `attempts`

Use `parserTrace` in logs to understand why a payload parsed or failed.
