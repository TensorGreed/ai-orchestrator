---
title: "Core nodes: inputs, LLM, agents, RAG and outputs"
description: "The core L2M nodes by group: inputs, prompting, LLM and agent, MCP tools, RAG and data, utilities and outputs, plus execution notes and the Output Parser."
---

# Core Nodes

The nodes most workflows are built from, by their type id (the `type` in workflow JSON). Every node, with its
fields, is in the [node reference](./reference/index.md).

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
- `chart`
- `execute_workflow`

## Output

- `output`

## Notes on execution

- Disconnected nodes are skipped.
- IF nodes take the `true` or `false` branch; Switch nodes route branches by evaluated case. Branches not taken are
  skipped.
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
