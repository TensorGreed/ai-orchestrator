---
title: "Branch a workflow on an LLM result"
description: "Send a webhook payload through a model, test the answer with an If node, and route it to one of two outputs. Plus what to do when the model call fails."
keys: "none"
keysNote: "None: runs on the built-in Echo model; a provider key for real answers"
tags: ["webhook","branching","starter"]
nodeCount: 5
sample: "conditional-flow.json"
demo: "wf-conditional"
demoRecorded: false
related: ["workflow-dag","improper-output-handling"]
---

<!--
  Generated from samples/workflows/conditional-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Branch a workflow on an LLM result

**What you get:** A webhook workflow that asks a model, checks the answer with an If node, and returns either the answer or "No answer generated".

**Needs:** None: runs on the built-in Echo model; a provider key for real answers · **Time:** 10 minutes · **Nodes:** 5

A **Webhook Input** at `POST /webhook/conditional-demo` passes `user_prompt`, `system_prompt` and `session_id` from the request body to an **LLM Call**. The **Check Answer** If node tests <span v-pre>`{{answer}}`</span>: if the model said anything, the **Success Output** returns it; if not, the **Error Output** returns "No answer generated". Only one output runs. As shipped, the model is the built-in Echo model, which answers with the prompt it gets and needs no key, and the webhook has no authentication.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/conditional-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-conditional" target="_self">Open it in the demo</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/conditional-flow.json" download>conditional-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/l2m/blob/main/samples/workflows/conditional-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Keep the built-in Echo model to check the branching first. For real answers, open the **LLM Call** node, pick a provider in the **Provider** list, set the model (**Load models** lists what the provider offers) and, for a hosted provider, its key, then save. For Ollama in Docker, use `http://host.docker.internal:11434/v1` for Ollama on the host (on Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the `api` service).
4. Send a request:

   ```bash
   curl -X POST http://localhost:4000/webhook/conditional-demo \
     -H "Content-Type: application/json" \
     -d '{"user_prompt": "Is order 1042 late?"}'
   ```
5. Open the run and click **Check Answer** to see `evaluatedValue` and which branch it took.

## How it works

<figure class="recipe-diagram">
<svg viewBox="76 76 1078 262" role="img" aria-labelledby="rd-branch-on-llm-output-title rd-branch-on-llm-output-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-branch-on-llm-output-title">Diagram of the Conditional Branching Flow workflow</title><desc id="rd-branch-on-llm-output-desc">Runs Webhook Input, then LLM Call, then Check Answer, then Success Output, then Error Output.</desc><defs><marker id="rd-branch-on-llm-output-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M290 207 C334 207 334 207 378 207" marker-end="url(#rd-branch-on-llm-output-arrow)"/><path class="rd-edge" d="M570 207 C614 207 614 207 658 207" marker-end="url(#rd-branch-on-llm-output-arrow)"/><path class="rd-edge" d="M850 207 C894 207 894 127 938 127" marker-end="url(#rd-branch-on-llm-output-arrow)"/><path class="rd-edge" d="M850 207 C894 207 894 287 938 287" marker-end="url(#rd-branch-on-llm-output-arrow)"/><g class="rd-node" data-kind="step" transform="translate(100 180)"><title>Webhook Input (webhook_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Webhook Input</text><text class="rd-type" x="12" y="40">webhook_input</text></g><g class="rd-node" data-kind="model" transform="translate(380 180)"><title>LLM Call (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">LLM Call</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(660 180)"><title>Check Answer (if_node)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Check Answer</text><text class="rd-type" x="12" y="40">if_node</text></g><g class="rd-node" data-kind="step" transform="translate(940 100)"><title>Success Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Success Output</text><text class="rd-type" x="12" y="40">output</text></g><g class="rd-node" data-kind="step" transform="translate(940 260)"><title>Error Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Error Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Webhook Input | [`webhook_input`](/nodes/reference/input#webhook-input-—-webhook-input) | Step in the run |
| LLM Call | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Step in the run |
| Check Answer | [`if_node`](/nodes/reference/utility#if-node-—-if) | Step in the run |
| Success Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Error Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

4 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## What a run does

We ran it on a fresh install with the echo model and with a local stand-in server:

- **Echo.** The webhook answered `{"output":{"result":"Echo: Is order 1042 late?"}}`. Check Answer evaluated to that text, took the `true` branch, and the Error Output was marked **skipped**.
- **No `user_prompt` in the body.** Echo still answers, with a hint: "Echo provider received no user message. Wire a Text Input or Prompt Template into this LLM Call to see the echo." The true branch ran. A real model would get an empty message instead.
- **An empty answer.** With a stand-in model that returns an empty string, the run took the `false` branch and returned `{"output":{"result":"No answer generated"}}`.
- **The model is down.** With the model's server unreachable, the run failed at the LLM Call after 4 attempts, the If node never ran, and the caller got HTTP 400 with `{"output":null,"error":"openai_compatible request failed after 4 attempt(s): fetch failed"}`. The message names the node's provider; our stand-in used `openai_compatible`.

So the false branch catches an empty answer, which is rare with a working model. A model error, a bad key or a timeout fails the run before the If node. Handle those with an error workflow (below).

## Write a better condition

The If node renders its condition as a template and reads the result as text. It is false when the text is empty, `false`, `0`, `null` or `undefined`, and true otherwise. That is why <span v-pre>`{{answer}}`</span> means "the model said something".

A condition with text outside its braces is one JavaScript expression: each <span v-pre>`{{ }}`</span> is replaced by its value, so <span v-pre>`{{score}} > 90`</span> compares a number and <span v-pre>`{{answer}} === 'yes'`</span> compares text. Quote text you compare with, since <span v-pre>`{{status}} == done`</span> is not an expression and fails the If node. The editor's preview under the condition shows `true` or `false` for the last run's data.

A condition can also be a JavaScript expression, run in a sandbox. With <span v-pre>`{{ answer.toLowerCase().includes("late") }}`</span>, "Is order 1042 late?" took the true branch and "Where is order 1042?" the false one. Two habits make conditions sturdier:

- **Ask the model for a label, not prose.** Tell it to answer with one word, such as `refund` or `question`, or parse JSON first with an Output Parser and test <span v-pre>`{{parsed.intent}}`</span>. See [extract structured JSON](/recipes/structured-output-json).
- **Use a Switch node for more than two paths.** It compares one value with a list of cases and routes to the first match, or to `default`.

## Handle failures with an error workflow

Build a second workflow that starts with an **Error Trigger**. Then open this workflow, choose **Error workflow…** in the editor's **⋯** menu, pick the second workflow and save (in JSON this is `"settings": { "errorWorkflowId": "<its id>" }`). When a run fails, L2M starts it with the failed run's details: `source_workflow_id`, `source_workflow_name`, `execution_id`, `error`, `error_stack` and `timestamp`.

We tested it with an error workflow whose HTTP Request step posts those fields to a local server. With the model down, it received `{"wf":"Conditional Branching Flow","err":"openai_compatible request failed after 4 attempt(s): fetch failed","exec":"..."}`. The caller of the webhook still gets the 400 error; the error workflow runs on the side, for alerts or clean-up.

## Make it yours

- Write the system prompt on the LLM Call node instead of taking `system_prompt` from the request, so callers cannot rewrite the model's instructions.
- Replace the two Output nodes with real work on each branch: a reply on one, a ticket or an approval on the other. End with a **Merge / Join** node if the branches should meet again.

## Make it safer

These controls are optional; the recipe runs without them.

- Secure the webhook before anyone else can reach it: a bearer token or an HMAC signature, and idempotency for retried calls. See [Secure webhooks](/security/secure-webhooks).
- A model's answer is untrusted text. Branch on a fixed label, not on free text that a caller can steer.
- Cap what callers can spend with a [budget](/product/budgets).

## Further reading

- [Utility nodes: IF and Switch](/nodes/reference/utility)
- [Secure webhooks](/security/secure-webhooks)
- [Workflows vs agents](/learn/agents/workflows-vs-agents)
- [Pattern library](/patterns/)
