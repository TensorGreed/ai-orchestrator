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

## Connector nodes run in demo fallback unexpectedly

- Check secret selection is not `None (demo fallback)`.
- Validate required endpoint/index/database fields.
- Run `Test Connection` in node config.
