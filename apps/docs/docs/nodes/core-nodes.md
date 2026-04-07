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
