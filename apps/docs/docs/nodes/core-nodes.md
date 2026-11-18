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
- `merge_node`
- `approval_gate`

## Utilities

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
