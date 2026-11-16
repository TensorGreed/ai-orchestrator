---
title: "Extract structured JSON from text with an LLM"
description: "Turn free text into JSON that matches a schema with the Output Parser node, retry when the model's JSON is invalid, and use the fields in later steps."
keys: "model"
keysNote: "A model: local Ollama as shipped, or a provider key"
tags: ["json","parsing","starter"]
nodeCount: 5
sample: "structured-output-flow.json"
demo: "wf-structured-output"
demoRecorded: false
related: ["output-checks","improper-output-handling","structured-tool-output"]
---

<!--
  Generated from samples/workflows/structured-output-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Extract structured JSON from text with an LLM

**What you get:** A workflow that asks a model for a sentiment label and returns it as checked JSON: `{"name": ..., "sentiment": "positive"}`.

**Needs:** A model: local Ollama as shipped, or a provider key · **Time:** 10 minutes · **Nodes:** 5

A **System Prompt** tells the model to answer only with JSON that has `name` and `sentiment` fields. The **LLM Call** answers the text from **Text Input**, and the **Output Parser** reads the answer as JSON and checks it against a schema: both fields required, `sentiment` one of `positive`, `negative` or `neutral`. If the check fails, the parser asks the same model to fix its answer, up to 2 times, and fails the run if it still does not match. As shipped, the model is `llama3.1` on a local Ollama server (`http://localhost:11434/v1`).

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/structured-output-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-structured-output" target="_self">Open it in the demo</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/structured-output-flow.json" download>structured-output-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/structured-output-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Open the **LLM Call** node and point it at a model you have: pull `llama3.1` into Ollama, or switch the provider and store its key as a [secret](/security/secrets). In Docker, `localhost` is the container: use `http://host.docker.internal:11434/v1` for Ollama on the host. On Linux that name resolves only if the `api` service has `extra_hosts: ["host.docker.internal:host-gateway"]`, which the repo's `docker-compose.yml` does not set. Save.
4. Run it, then open the run and click **Output Parser** to see `parsed`, `retries` and `parserTrace`.
5. Change the text on **Text Input** and run it again.

## How it works

<figure class="recipe-diagram">
<svg viewBox="76 36 1078 222" role="img" aria-labelledby="rd-structured-output-json-title rd-structured-output-json-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-structured-output-json-title">Diagram of the Structured Output Parser Flow workflow</title><desc id="rd-structured-output-json-desc">Runs Text Input, then System Prompt, then LLM Call, then Output Parser, then Output.</desc><defs><marker id="rd-structured-output-json-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M290 87 C334 87 334 207 378 207" marker-end="url(#rd-structured-output-json-arrow)"/><path class="rd-edge" d="M290 207 C334 207 334 207 378 207" marker-end="url(#rd-structured-output-json-arrow)"/><path class="rd-edge" d="M570 207 C614 207 614 207 658 207" marker-end="url(#rd-structured-output-json-arrow)"/><path class="rd-edge" d="M850 207 C894 207 894 207 938 207" marker-end="url(#rd-structured-output-json-arrow)"/><g class="rd-node" data-kind="step" transform="translate(100 180)"><title>Text Input (text_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Text Input</text><text class="rd-type" x="12" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(100 60)"><title>System Prompt (system_prompt)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">System Prompt</text><text class="rd-type" x="12" y="40">system_prompt</text></g><g class="rd-node" data-kind="model" transform="translate(380 180)"><title>LLM Call (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">LLM Call</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(660 180)"><title>Output Parser (output_parser)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output Parser</text><text class="rd-type" x="12" y="40">output_parser</text></g><g class="rd-node" data-kind="step" transform="translate(940 180)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Text Input | [`text_input`](/nodes/reference/input#text-input-—-text-input) | Step in the run |
| System Prompt | [`system_prompt`](/nodes/reference/input#system-prompt-—-system-prompt) | Step in the run |
| LLM Call | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Step in the run |
| Output Parser | [`output_parser`](/nodes/reference/utility#output-parser-—-output-parser) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

5 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## What a run does

We did not run the sample against Ollama. We ran it with the echo model and with a small local stand-in server that returns fixed answers, to see each parser path:

| The model answered | Result |
| --- | --- |
| `{"name": "product review", "sentiment": "positive"}` | Success, `retries: 0`, strategy `json_parse` |
| The same JSON inside a ```` ```json ```` block, after "Here is the result:" | Success, `retries: 0` |
| `"sentiment": "very happy"`, then valid JSON on the retry | Success, `retries: 1` |
| `"sentiment": "very happy"` every time | Run fails: `Output Parser failed after 2 retries: Field 'sentiment' value 'very happy' not in enum: positive, negative, neutral` |
| "The sentiment is clearly positive." every time | Run fails: `Output Parser failed after 2 retries: Invalid JSON (strict): ...` |

Each retry is a separate call to the same model, with the system prompt "You are a JSON formatting assistant. Output ONLY valid JSON." and a message that names the error, the schema and the original answer. Retries cost tokens like any other call.

With **echo**, the run fails, and it is worth knowing why. Echo's answer is the prompt, not JSON, so the parser retries, and echo repeats the correction message back. That message contains the schema, which is a JSON object, so the parser finds it, and rejects it: `Missing required field: name`. The parser looks for JSON anywhere in the text, so prose that quotes JSON can parse to something you did not mean.

On success, the **Output** node's <span v-pre>`{{parsed}}`</span> renders the object as a JSON string: `{"name":"product review","sentiment":"positive"}`.

## What the schema check covers

In `json_schema` mode the parser checks the top level of the object only: each field in `required` is present, a field typed `string`, `number` or `boolean` has that type, and a field with `enum` holds one of the listed values. Nested objects, arrays, `integer` and formats are not checked. For a full JSON Schema check, add an **Output Guardrail** node with the **Matches a JSON Schema** check and a schema, or an answer schema [output check](/product/content-rules-output-checks#answer-schema). Both are optional.

The LLM Call node does not ask the provider for a JSON mode; the JSON comes from the system prompt. That is why the parser and its retries are there.

## When parsing fails

Set **Parsing Strictness** (`parsingMode`) on the parser:

- `strict` (default): the answer, a fenced block in it, or the first complete object in it must be valid JSON.
- `lenient`: also repairs common slips such as single quotes, trailing commas, unquoted keys and Python literals.
- `anything_goes`: also reads simple `key: value` lines. When parsing or the schema check still fails after the retries, the run does not fail: the parser returns `parsed: null` and a `warning`. We saw this with the prose answer above, so check for `null` before you use the result.

`parserTrace` in the node output lists each strategy tried and why it failed. See [Output Parser fails with Invalid JSON](/troubleshooting/common-issues#output-parser-fails-with-invalid-json-even-though-response-includes-json).

## Use the result downstream

Later nodes read the fields by path. With the Output template set to `Sentiment: ` followed by <span v-pre>`{{parsed.sentiment}}`</span>, our run returned `Sentiment: positive`. To route on a field, put an If node after the parser with a condition such as <span v-pre>`{{ parsed.sentiment === "negative" }}`</span>: see [branch a workflow on an LLM result](/recipes/branch-on-llm-output).

## Make it yours

- Edit the schema on the parser (a JSON string in **JSON Schema (Required for strict mode)**) and the system prompt together: name the same fields and values in both.
- Set **Parser Mode** to **Item List** (`item_list`) for a plain list, one item per line, returned as `items` and `count`.
- Set **LLM Max Auto-Retries** (`maxRetries`) to 1 to limit the extra calls. A value of 0 is read as the default, 2, so retries cannot be turned off this way.

## Make it safer

These controls are optional; the recipe runs without them.

- Treat parsed fields as untrusted input, especially when the source text came from outside: validate them before they reach a database, a shell or a URL.
- Cap model spend, retries included, with a [budget](/product/budgets).

## Further reading

- [Core nodes: Output Parser](/nodes/core-nodes#output-parser-output-parser)
- [Output checks: answer schema](/product/content-rules-output-checks#answer-schema)
- [Pattern library](/patterns/)
- [OWASP LLM05:2025 Improper Output Handling](https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/)
