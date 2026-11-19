---
title: "Templates and expressions: reading data between steps"
description: "What a {{ }} template in an L2M node can read (parents, earlier steps, input, variables, loops), how autocomplete helps and what strict templates do."
---

# Templates and expressions

::: v-pre

Most text settings on a node take templates: prompts, URLs, request bodies and headers, Set field values, response templates, file names. Everything between `{{` and `}}` is replaced when the node runs.

The body of a `{{ }}` is one of two things:

- **A path**: letters, digits, `_`, `-` and dots, such as `{{user_prompt}}` or `{{results.fetch.items.0.title}}`. A number segment picks an array item.
- **An expression**: anything else, such as `{{ answer.trim() }}` or `{{ $if(score > 90, 'high', 'low') }}`. Expressions run in a sandbox with a time and memory limit ([code execution](/security/code-execution)).

A string renders as it is, a number or `true`/`false` as text, and an object or array as JSON.

## What a template can read

A node's template sees the steps connected straight into it, the run's input, and every step that has already finished, but each through its own form:

| Form | What it reads | Example |
|---|---|---|
| `{{field}}` | A field of a step connected straight into this one (a direct parent). | `{{answer}}` |
| `{{nodeId.field}}` | The output of a direct parent, by its node id. | `{{fetch.status}}` |
| `{{ $json.nodeId.field }}`, `{{ $input.… }}` | The same data as the two forms above, in an expression. | `{{ $json.fetch.status }}` |
| `{{parent_outputs.nodeId.field}}` | A direct parent's output, by its node id. | `{{parent_outputs.fetch.status}}` |
| `{{results.nodeId.field}}` | The output of **any step that has already finished** in this run. | `{{results.fetch.body.title}}` |
| `{{ $node('nodeId').output.field }}` | The same as `results`, in an expression. | `{{ $node('fetch').output.status }}` |
| `{{user_prompt}}`, `{{system_prompt}}`, `{{session_id}}`, `{{webhook.field}}`, `{{trigger_type}}` | The run's input and trigger payload, in every node. | `{{webhook.customer.id}}` |
| `{{vars.name}}`, `{{ $vars.name }}` | Workflow variables, in every node. | `{{vars.API_URL}}` |
| `{{workflow.id}}`, `{{workflow.name}}`, `{{execution.id}}`, `{{execution.customData.key}}` | The workflow and this run. `$workflow` and `$execution` work in expressions. | `{{execution.id}}` |

The node id is the id in the workflow JSON, not the label on the canvas. A node added in the editor gets an id made from its label when it is added: "Fetch items" becomes `fetch_items`, and a one-word label is numbered (`set_1`, `output_1`) so the id never reads like a field name. A second node with the same label gets the next number (`http_request_2`). Renaming a node changes its label only: the id stays, so templates, pinned data and past runs keep pointing at it. The template autocomplete shows each step's label next to its id.

Nodes added before this change, and workflows from elsewhere, keep ids such as `http_request-k3j9x2`. A path body takes such an id as it is: `{{results.http_request-k3j9x2.body}}`. In an expression, a `-` is a minus sign, so write `results['http_request-k3j9x2'].body` or `$node('http_request-k3j9x2').output.body`. A direct parent's field with the same name as a run input (a parent that outputs `user_prompt`, say) is the one `{{user_prompt}}` reads.

### Direct parents and earlier steps

`{{field}}` and `{{nodeId.field}}` follow the item from step to step: a node sees what its direct parents produced, not what came before them. Two steps away, they render empty.

```text
fetch → summarize → report
```

In `report`, `{{summarize.text}}` works, but `{{fetch.body}}` renders empty because `fetch` is not a direct parent of `report`. Use `{{results.fetch.body}}` (or `{{ $node('fetch').output.body }}`) to read any step that has already finished, wherever it is in the graph.

Steps that pass their input on keep the parent's data in reach: after a No-op, Wait, Filter, IF, Switch or Chat Intent Router step, or a disabled node, for example, `{{fetch.body}}` still works in the next node. `parent_outputs` holds the direct parents only, so `{{parent_outputs.fetch.body}}` does not see through them.

A step that has not run yet (it comes later, or its branch was skipped) is not in `results`, unless its output is pinned: reading it renders empty.

If a step checks a value with [content rules](/product/content-rules), read the value that step passes on (`{{field}}` in the node after it). `{{results.<id>.field}}` and `$node('<id>')` of a step before the check read the value from before the check.

### Loops

The nodes connected straight after a **Loop / ForEach** node run once per item. Only those repeat: a node after them runs once, after the loop. With **Branches route in the loop** on (new Loops), the nodes on the outputs of an IF, Switch or Filter in the body repeat too, on the passes that take that output (see [Branches in a Loop body](/nodes/core-nodes#branches-in-a-loop-body)). Inside a pass, `{{item}}` (or the name set in **Item variable**) is the current item and `{{_loop_index}}` its position, from 0.

After the loop, a loop body node's result is its **last pass** (with branch routing, the last pass that ran it): `{{results.<bodyId>.field}}`, and the nodes after it, see that pass only. To use every pass, read the Loop node's output: `{{results.<loopId>.items}}` is a list with one entry per pass, each with `index`, `item` and `outputs.<bodyId>`; `{{results.<loopId>.count}}` is the number of passes.

Two shorter ways to get every pass:

- Turn on **Collect results** on the Loop (new Loops have it on). Its output then also has `collected`: one entry per pass, the body node's output (with several body nodes, each pass's outputs by body node id). `{{results.<loopId>.collected}}` is that list.
- Connect the body node into a **Merge / Join** node in **Collect loop passes** mode. Its output is `items`, every pass of that node in order, and `count`.

On the canvas, a body node's card counts its passes and the items of all of them ("success · 25 passes · 25 items"); its Run data shows the last pass.

```text
{{ results.loop.items.map(pass => pass.outputs.summarize.text).join('\n') }}
```

## Writing templates in the editor

- **Autocomplete.** Type `{{` in a template field for a list of what the node can read, filled from the last run (or pinned data): the fields of the steps connected straight in, the run input (`webhook.…`, `user_prompt`), variables (`vars.…`), and every step under `results.<nodeId>`, with its label and its value in that run. Keep typing to filter; the arrow keys move, Enter or Tab inserts the path and closes the `}}`, Escape closes the list. Type `$json.` inside `{{ }}` for the same fields as an expression. Without a run, the list still offers each step's `results.<nodeId>` and the variables.
- **Drag a field.** In the inspector's side-by-side view, drag a field name from the **Input** pane into a text field: it inserts `{{field}}` where you drop it. With one step connected straight in, a field drags as `{{field}}`; with several, as `{{results.<nodeId>.field}}`, so it names the step. A column of a list drags its first item's field (`{{items.0.title}}`).
- **Preview.** Each template field shows what it renders with the last run's data. When the node ran and a `{{ }}` has no value in that run, a note under the field names it.

## When a value is missing

By default, a template never fails a node for a missing value: a path that does not resolve renders as an empty string. So does an expression that throws or runs out of time, such as `{{ $node('fetch').output.body.title }}` before `fetch` has run. Only a failure of the sandbox itself fails the node ([code execution](/security/code-execution)). The editor's preview names each such `{{ }}` (see above).

### Strict templates

Turn on **Strict templates** in the workflow's **More actions** menu to make a missing value fail the node instead (`settings.strictTemplates: true` in the workflow JSON; off by default). With it on, a node fails when a `{{ }}` in a setting it renders:

- is a path with no value, such as `{{customer.id}}` when the input has no `customer`;
- is an expression that returns nothing (`undefined`) or fails, such as `{{ $json.customer.name.first }}`.

The error names the template, for example `Template {{customer.id}} has no value, and this workflow uses strict templates`, and the node's result carries `errorCode: "template_value_missing"` (a webhook caller gets it as `code`). The failure is not retried, and the node's **On Error** setting applies as for any other failure, so an Error output can catch it. A field that holds `null` still renders empty, and so do the run's optional prompt fields `{{system_prompt}}`, `{{user_prompt}}` and `{{session_id}}`, which nodes read by default and fall back from when the run has none. A Respond to Webhook node without its own body template (the default `{{result}}`) is not affected either.

- IF conditions follow the setting: a condition that tests whether a field is there, such as `{{ $json.coupon }}`, fails when it is missing. Write the test out instead: `{{ $json.coupon !== undefined }}`.
- A sub-workflow uses its own setting, not its caller's.
- A Set field of any type follows the setting: with type **Auto** (or Number, Boolean, JSON), a value of one `{{ }}` with no value fails the node instead of becoming `null`.
- A Filter in **Keep matching items** mode applies it to each item's condition values: a value such as `{{item.min}}` that one item lacks fails the Filter. A condition's **Field** is not a template: an item without that field is compared as an empty value, as before.
- Templates you write fail the node wherever they are, including an MCP Tool node's arguments, an agent's server prompt arguments and a Supervisor worker's own prompts (the Supervisor fails with it). Arguments an agent's model generates are not templates: a `{{ }}` in them is sent as it is, and a tool that fails returns its error to the model.
- When [content rules](/product/content-rules) check a node's outbound settings before it sends, the check itself renders without strict templates (it reads settings the node may not use). The node then fails on a path without a value in a setting it sends; an expression in such a setting is not evaluated a second time.

A path only walks objects and arrays: on a text, `{{answer.length}}` renders empty. Write it as an expression instead, such as `{{ answer.trim().length }}`.

When a template renders empty, check, in this order:

1. The node id: open the step and compare its id with the one in the template.
2. Whether the step is a direct parent. If not, use `{{results.<nodeId>.field}}`.
3. Whether the step ran before this one in the last run (the run's trace shows each step's output).
4. The field path: the step's **Output** tab in the inspector shows the exact shape.

The editor's preview under each template field renders it as a run would, with the last run's data: the node's recorded input, and every step's output as `results`.

## Expressions

Expressions are JavaScript with these names available:

| Name | Value |
|---|---|
| `$json`, `$input` | The node's template data: its direct parents' fields, the run input, `results`, `vars`, `workflow`, `execution`. |
| `$node('nodeId').output` | The output of any step that has already finished (the same as `results.nodeId`). |
| `$vars` | Workflow variables. |
| `$workflow`, `$execution` | `id` and `name`; `id` and `customData`. |
| `$now`, `$today` | The current time, and today at midnight, as `Date`s. |
| `$if(condition, a, b)`, `$ifEmpty(value, fallback)` | Small helpers. |
| `$jmespath(value, 'path')` | A JMESPath-style lookup. |
| `$env` | A small, curated set of environment values (never secrets). |

Every top-level field of the template data whose name is a valid JavaScript name is also a name of its own, so `{{ answer.toUpperCase() }}` and `{{ results.fetch.status === 200 ? 'ok' : 'retry' }}` both work.

:::

## Related

- [Core nodes](/nodes/core-nodes) and the [node reference](/nodes/reference/): which fields each node has.
- [Code execution](/security/code-execution): the sandbox, its limits and the Code node.
- [Data labels](/product/data-labels-and-destinations): a template read carries the labels of the step it reads.
- [Common issues](/troubleshooting/common-issues#a-template-renders-empty-two-steps-away): a template two steps away renders empty.
- Background: [Why a workflow template renders empty two steps away](/blog/workflow-templates-two-steps-away) (blog).
