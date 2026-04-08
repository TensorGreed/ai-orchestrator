# Core Nodes

## Input

- `webhook_input`
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

## RAG / Data

- `rag_retrieve`
- `connector_source`

## Utilities

- `simple_memory`
- `switch`
- `output_parser`
- `http_request`
- `code_execution`
- `pdf_output`
- `execute_workflow`

## Output

- `output`

## Notes on execution

- Disconnected nodes are skipped.
- Switch nodes route branches by evaluated case.
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
