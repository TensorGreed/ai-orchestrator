# Workflow Editor

## Core editor capabilities

- Drag/drop node palette
- Node-to-node edge connections
- Curved edges
- Node configuration via modal
- Node delete (`Delete` key)
- Save/import/export workflows
- Execution logs pane and run-inputs pane
- Per-node execution status visualization
- Agent port `+` buttons that open filtered drawers for Language Models, Memory, Tools, and Workers

## Typical flow patterns

1. Basic LLM:
   - `text_input -> prompt_template -> ollama_chat_model -> output`
2. Agentic tool loop:
   - `webhook_input -> agent_orchestrator -> output`
   - Attachments:
     - `chat_model`: any Chat Model node, including OpenAI, Anthropic, Ollama, OpenAI Compatible, AI Gateway, Azure OpenAI, Gemini, or legacy `llm_call`
     - `memory`: `local_memory`
     - `tool`: one or more `mcp_tool`
3. RAG:
   - `text_input -> rag_retrieve -> prompt_template -> llm_call -> output`

## Validation behavior

Validation checks include:

- Graph structure and required edges
- Required node config fields
- Attachment-type correctness (for agent/supervisor ports)
- Node-type specific rules

Non-connected nodes are not executed.
