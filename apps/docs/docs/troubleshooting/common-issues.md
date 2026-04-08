# Common Issues

## `SECRET_MASTER_KEY_BASE64 environment variable is required`

Set `SECRET_MASTER_KEY_BASE64` in `.env` with a base64-encoded 32-byte value.

## Webhook 404 on `/webhook-test/:path`

- Ensure `webhook_input` node `path` matches exactly.
- Ensure workflow containing that webhook path is saved.

## MCP tool discovery returns unexpected tools

- Check MCP endpoint/base URL in `mcp_tool` node.
- Re-run discovery after endpoint change.
- Verify you are not using stale node config.

## Agent hits max iterations

- Reduce tool set size.
- Improve prompt constraints for tool usage and stop conditions.
- Increase context window/model limits where possible.
- Raise max iterations only when needed.

## Context-length/token overflow

- Do not expose very large tool catalogs to the model.
- Use selective tool inclusion.
- Keep tool descriptions and schemas concise.
- Keep `Persist Tool Messages` disabled on memory unless you explicitly need full tool transcripts.
- If you use attached MCP Tool nodes, remove legacy `agent_orchestrator.config.mcpServers` entries from older workflows.

## Local LLM crash / segmentation fault after tool-heavy runs

- This usually indicates context exhaustion in the local inference server.
- Reduce `Tool Message Max Chars` and max iterations.
- Limit attached tools to the minimum needed for the task.
- Clear old session history or use a fresh `session_id` before retrying.

## Follow-up prompt did not reuse previously fetched MCP data

- Ensure follow-up uses the same `session_id`.
- Ensure Agent has memory namespace stable across runs.
- Keep `persistToolMessages` off unless you explicitly need raw tool transcripts in prompt context.
- Runtime now provides `session_cache_list` and `session_cache_get`; follow-up prompts can explicitly ask agent to reuse cached results before making new MCP calls.

## Output Parser fails with `Invalid JSON` even though response includes JSON

- In `Output Parser`, keep `mode=json_schema` and change `parsingMode`:
  - start with `lenient`
  - use `anything_goes` only when upstream outputs are highly inconsistent
- Set `inputKey` to a concrete path (or moustache path), for example:
  - `debug.agent_answer`
  - `&#123;&#123;debug.agent_answer&#125;&#125;`
  - `messages[5].content`
- Inspect `parserTrace` in node output to see which parse strategy was attempted and why it failed.

## Connector nodes run in demo fallback unexpectedly

- Check secret selection is not `None (demo fallback)`.
- Validate required endpoint/index/database fields.
- Run `Test Connection` in node config.
