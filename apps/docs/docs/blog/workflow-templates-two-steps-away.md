---
title: "Why a workflow template renders empty two steps away"
description: "How data flows between steps in a workflow DAG, what results and $node() read, why a missing value renders empty, and how we made previews match runs."
date: 2026-11-16
author: "The L2M team"
related: [ai-agent]
socialCard: true
---

# Why a workflow template renders empty two steps away

Almost every text setting on an L2M node is a template: a prompt, a URL, a request body, a file name. The most common question about templates is some form of "why is this empty?". On 13 November 2026 we merged a fix and a new reference page that answer it: `$node()` now works in templates, and the editor's preview renders a template exactly the way a run does. This post explains the scope rules behind the question. They apply to any workflow engine that passes data along a graph.

::: v-pre

## Two ways to pass data along a graph

A workflow is a directed graph of steps. There are two ways a step can see data from earlier steps, and they answer different needs.

**Item flow.** Each step receives what its direct parents produced, and passes on what it produces. This is how data moves along the edges you draw. It keeps a step's inputs local and obvious: look at the arrows going in.

**A run-wide results map.** Every step that has finished writes its output into one map, keyed by step id, and any later step may read any entry. This is how you reach a step that is not directly connected.

L2M templates offer both, each through its own syntax:

| Form | Reads |
| --- | --- |
| `{{field}}`, `{{nodeId.field}}`, `{{ $json.nodeId.field }}` | A direct parent's output (item flow) |
| `{{results.nodeId.field}}` | Any step that has already finished in this run |
| `{{ $node('nodeId').output.field }}` | The same as `results`, inside an expression |
| `{{user_prompt}}`, `{{webhook.field}}`, `{{vars.name}}` | The run's input, trigger payload and variables, in every node |

## The two-steps-away case

Take three steps in a line:

```text
fetch → summarize → report
```

In `report`, `{{summarize.text}}` works: `summarize` is a direct parent. `{{fetch.body}}` renders empty, because `fetch` is not. The data did not disappear; `report` is looking in the wrong place. `{{results.fetch.body}}` reads it from the run-wide map.

Some steps blur the line on purpose. A No-op, Wait, Filter, IF, Switch or Chat Intent Router step, or a disabled node, for example, passes its input on, so after one of those, `{{fetch.body}}` still works in the next node. That is convenient, and it is also why the rule feels inconsistent until you know it: insert a real processing step between two nodes and a template that used to work goes empty.

Why not let every template read everything by name? Because item flow is what makes loops and branches readable. Inside a loop, `{{item}}` is the current item; a global lookup has no notion of "current". The results map is the escape hatch, and naming it explicitly (`results.`) makes it visible in review that a step reaches across the graph.

Two more consequences follow from "already finished":

- A step that has not run yet, because it comes later or its branch was skipped, is not in `results`. Reading it renders empty, unless its output is pinned.
- After a loop, a loop body node's entry in `results` is its **last pass**. To use every pass, read the Loop node's own output: `{{results.loop.items}}` holds one entry per pass, each with `index`, `item` and `outputs.<bodyId>`.

```text
{{ results.loop.items.map(pass => pass.outputs.summarize.text).join('\n') }}
```

## Why missing values render empty

A template never fails a node for a missing value. A path that does not resolve renders as an empty string, and so does an expression that throws or times out, such as `{{ $node('fetch').output.body.title }}` before `fetch` has run.

This is a trade-off, and we kept it deliberately. Workflows routinely have optional fields: a webhook that sometimes carries a customer id, a branch that sometimes runs. Failing the node on every missing value would make those workflows brittle and push everyone to wrap every field in a fallback. The cost is that typos and wrong scopes are silent, which is why the editor now shows a tip under the template field you are editing, and why the preview matters so much (below).

There is one exception, and it is the important one. If the expression sandbox itself fails (it cannot start, or crashes), the node fails. The comment in the renderer says why: "an IF or Switch must never branch on a value that silently lost its expression". A missing value is a property of your data; a broken sandbox is a property of the system, and hiding it would make a condition quietly take the wrong branch.

When a template renders empty, check in this order: the node id (the id in the workflow JSON, not the label on the canvas), whether the step is a direct parent, whether it ran before this one in the last run, and the field path against the step's **Output** tab.

## The bug: `$node()` was always empty

`{{ $node('fetch').output.status }}` was documented as the expression form of `{{results.fetch.status}}`. In templates it always rendered empty. The template renderer built the sandbox's context from the template data but never passed the node outputs to it, so `$node()` looked up every id in an empty map, and, by the rule above, rendered empty without a word.

The fix itself is one line: `$node()` reads the same object as `results`. A small detail kept it cheap: because it is literally the same object, the payload sent to the sandbox includes it once, not twice.

The more useful lesson is how it slipped through. `$node('X')` and `results.X` were meant to be two spellings of one thing, and the data labels, destination checks and content capture code already treated a `$node('X')` read as a read of X. But nothing tested the two spellings side by side through the template renderer. The new tests do exactly that: for each feature that cares about what a template read, one case with `results.X` and one with `$node('X')`, expecting the same result. When a system has two syntaxes for one meaning, test them as a pair.

## Making the preview match the run

Under each template field, the editor shows a preview rendered with the last run's data. A preview is only useful if it is right; a preview that differs from the run is worse than none, because it teaches you to trust a wrong answer.

Ours differed in two ways.

First, the preview sent the whole template to the expression renderer, which treats every `{{ }}` body as JavaScript. Node ids created in the editor contain a dash, such as `http_request-k3j9x2`. In a path, `{{results.http_request-k3j9x2.body}}` is fine. Read as JavaScript, the dash is a minus sign, so the preview computed a subtraction while the run read the field.

Second, a node's recorded input only holds its direct parents' data, so `results` in the preview did not contain the other steps' outputs at all.

Both are symptoms of one mistake: the preview had its own way of rendering. The fix removes it. The preview endpoint (`POST /api/expressions/preview`) now renders a template with the engine's own renderer, with the last run's node outputs as `results` (and so `$node()`). Paths resolve as paths, number segments pick array items, and dashed ids work, exactly as in a run. Expression mode, where the whole body is JavaScript, keeps its old behaviour, and previews still count against the user's own sandbox circuit breaker, not a workflow's.

The general rule: **a preview must call the same code as the real thing**, with the same data, or it will drift. A second implementation, however small, is a second set of bugs.

## Dashed ids in expressions

One rough edge remains by design. Inside an expression, a dash is still a minus sign, because it is JavaScript. Write ids with dashes using bracket access or `$node()`:

```text
{{ results['http_request-k3j9x2'].body }}
{{ $node('http_request-k3j9x2').output.body }}
```

## What it does not do

- Templates do not warn about values that do not resolve; they render empty. Use the preview and the step's **Output** tab.
- `results` holds only steps that have finished. It cannot read ahead or into a skipped branch.
- A path walks objects and arrays only: on a text, `{{answer.length}}` renders empty. Use an expression such as `{{ answer.trim().length }}`.

:::

## Try it in L2M

Open the [live demo](https://lsquarem.com/demo/){target="_self"}, no sign-up needed, and open a node's settings to see templates in use. The [templates and expressions](/runtime/templates-and-expressions) page is the full reference: every form, loops, empty values and the expression helpers. [Common issues](/troubleshooting/common-issues#a-template-renders-empty-two-steps-away) has the checklist, and [code execution](/security/code-execution) covers the sandbox expressions run in. For when a fixed graph is the right choice and when an <Term id="ai-agent">agent</Term> should decide, read [Workflows vs agents](/learn/agents/workflows-vs-agents).

## Further reading

- [Property accessors](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Property_accessors): dot notation needs a valid identifier, bracket notation takes any string (MDN)
- Pull request: [#214 `$node()` in templates, scope docs and preview parity](https://github.com/TensorGreed/ai-orchestrator/pull/214) (GitHub)
