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
  - supported: `openai_chat_model`, `anthropic_chat_model`, `ollama_chat_model`, `openai_compatible_chat_model`, `ai_gateway_chat_model`, `azure_openai_chat_model`, `google_gemini_chat_model`, `llm_call`
- `memory`: attach `local_memory`
- `tool`: attach one or more `mcp_tool`
- `worker`: attach worker agents (supervisor use cases)

In the visual editor, use the `+` button below an Agent port to open a filtered drawer for compatible Language Model, Memory, or Tool nodes. Clicking an item creates and attaches it automatically.

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

## Session tool cache (multi-turn reuse)

The runtime persists full MCP tool outputs outside prompt context and exposes cache tools back to the model for follow-up turns.

Behavior:

1. External MCP tool call completes.
2. Runtime stores full args/output by `namespace + session_id`.
3. Runtime gives the model compact in-context tool messages.
4. On later turns, model can call:
   - `session_cache_list`
   - `session_cache_get`
5. Model reuses prior fetched data instead of repeating expensive MCP calls.

Notes:

- Cache tools are injected automatically when `session_id` is present.
- Reuse depends on stable `session_id` and memory namespace.
- Cached payloads are stored in SQLite table `session_tool_cache`.

## Mid-turn clarification (`agent_clarify`)

The runtime exposes a third built-in tool — `agent_clarify` — that the agent can call whenever it needs information only the user can provide. It's always available, regardless of whether a `session_id` is set.

### How it works

1. The agent decides it can't proceed without more info and calls `agent_clarify({ question, reason? })`.
2. The runtime breaks out of the iteration loop *before* invoking the tool body. The assistant's tool-call message is saved to session memory.
3. `run()` returns with `stopReason: "clarification_requested"` and a `clarification` field containing the question, optional reason, and the tool call id.
4. The `agent_orchestrator` node surfaces the clarification on its output. The workflow's top-level result also carries a `clarification` field so chat UIs and webhook callers don't have to dig into `nodeResults`.

### Resume

On the next `run()` call with the same `sessionId` and a non-empty `userPrompt`:

1. The runtime loads session memory, sees the orphaned `agent_clarify` tool call.
2. It injects the new `userPrompt` as the **tool result** for that call (not as a fresh user message) — so the LLM sees a clean tool-call → tool-result exchange in the standard tool-calling protocol.
3. The agent loop continues from there. The next assistant turn is the answer.

For chat triggers this happens automatically — every chat message in the same session reuses the same `session_id`, so the next user reply resumes naturally.

For non-chat triggers (webhook, schedule), the workflow caller inspects `result.clarification` and re-invokes the workflow with the reply as `user_prompt`.

### What gets persisted

Tool results are normally filtered from session memory (the in-context tool message has the full output). The `agent_clarify` tool result is the exception — it's always persisted, so the resume-detection on subsequent runs sees the question as *answered* and doesn't re-resume.

### When to use it

- ✅ The user said "send him an email" without specifying who.
- ✅ The user asked for "the report" without saying which one.
- ❌ Don't use it as a confirmation gate. If the request is clear, just do it.
- ❌ Don't use it to ask the user to fix the user's own typo — make the best reasonable inference.

### Chat UI

When the workflow result carries `clarification`, the chat bubble renders with a "?" badge labeled **"Assistant is asking"**, the question as the body, and the optional `reason` below it as italic context. The bubble looks different enough from a regular answer that users can tell at a glance "the agent is waiting on me."

Sample workflow: [`samples/workflows/agent-clarify-flow.json`](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/agent-clarify-flow.json).
