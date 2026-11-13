---
title: "Templates and expressions: reading data between steps"
description: "What a {{ }} template in an L2M node can read: direct parents, any earlier step with results or $node(), run input, variables, loops and empty values."
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

The node id is the id in the workflow JSON, not the label on the canvas. A direct parent's field with the same name as a run input (a parent that outputs `user_prompt`, say) is the one `{{user_prompt}}` reads.

### Direct parents and earlier steps

`{{field}}` and `{{nodeId.field}}` follow the item from step to step: a node sees what its direct parents produced, not what came before them. Two steps away, they render empty.

```text
fetch → summarize → report
```

In `report`, `{{summarize.text}}` works, but `{{fetch.body}}` renders empty because `fetch` is not a direct parent of `report`. Use `{{results.fetch.body}}` (or `{{ $node('fetch').output.body }}`) to read any step that has already finished, wherever it is in the graph.

Steps that pass their input on keep the parent's data in reach: after a No-op, Wait, IF, Switch or Chat Intent Router step, or a disabled node, `{{fetch.body}}` still works in the next node. `parent_outputs` holds the direct parents only, so `{{parent_outputs.fetch.body}}` does not see through them.

A step that has not run yet (it comes later, or its branch was skipped) is not in `results`, unless its output is pinned: reading it renders empty.

If a step checks a value with [content rules](/product/content-rules), read the value that step passes on (`{{field}}` in the node after it). `{{results.<id>.field}}` and `$node('<id>')` of a step before the check read the value from before the check.

### Loops

The nodes connected straight after a **Loop / ForEach** node run once per item. Inside a pass, `{{item}}` (or the name set in **Item variable**) is the current item and `{{_loop_index}}` its position, from 0.

After the loop, a loop body node's result is its **last pass**: `{{results.<bodyId>.field}}`, and the nodes after it, see that pass only. To use every pass, read the Loop node's output: `{{results.<loopId>.items}}` is a list with one entry per pass, each with `index`, `item` and `outputs.<bodyId>`; `{{results.<loopId>.count}}` is the number of passes.

```text
{{ results.loop.items.map(pass => pass.outputs.summarize.text).join('\n') }}
```

## When a value is missing

A template never fails a node for a missing value: a path that does not resolve renders as an empty string, with no warning. So does an expression that throws or runs out of time, such as `{{ $node('fetch').output.body.title }}` before `fetch` has run. Only a failure of the sandbox itself fails the node ([code execution](/security/code-execution)).

A path only walks objects and arrays: on a text, `{{answer.length}}` renders empty. Write it as an expression instead, such as `{{ answer.trim().length }}`.

When a template renders empty, check, in this order:

1. The node id: open the step and compare its id with the one in the template.
2. Whether the step is a direct parent. If not, use `{{results.<nodeId>.field}}`.
3. Whether the step ran before this one in the last run (the run's trace shows each step's output).
4. The field path: the step's **Output** tab in the inspector shows the exact shape.

The editor's preview under each template field renders it with the last run's data, `results` included.

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

Every top-level field of the template data is also a name of its own, so `{{ answer.toUpperCase() }}` and `{{ results.fetch.status === 200 ? 'ok' : 'retry' }}` both work.

:::

## Related

- [Core nodes](/nodes/core-nodes) and the [node reference](/nodes/reference/): which fields each node has.
- [Code execution](/security/code-execution): the sandbox, its limits and the Code node.
- [Data labels](/product/data-labels-and-destinations): a template read carries the labels of the step it reads.
- [Common issues](/troubleshooting/common-issues#a-template-renders-empty-two-steps-away): a template two steps away renders empty.
