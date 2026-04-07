# Agent Loop

## Execution model

Agent orchestration is iterative, not one-shot.

1. Collect messages (`system_prompt`, `user_prompt`, optional memory context)
2. Collect attached tool metadata from `mcp_tool` nodes
3. Call model with tool definitions
4. If model returns tool calls:
   - execute tool(s)
   - append tool outputs to conversation
   - call model again
5. Stop on final answer or `maxIterations`

## Attachment ports

- `chat_model`: attach model node
  - supported: `llm_call`, `azure_openai_chat_model`
- `memory`: attach `simple_memory`
- `tool`: attach one or more `mcp_tool`
- `worker`: attach worker agents (supervisor use cases)

## Common failure causes

- No model node attached to `chat_model`
- Tool definitions too large for model context
- Missing credential secret refs
- Max iterations too low for required task depth

## Reliability guidance

- Keep tool schema concise
- Restrict tool set to task-relevant tools
- Set explicit max iterations
- Ensure upstream nodes provide stable prompt fields
