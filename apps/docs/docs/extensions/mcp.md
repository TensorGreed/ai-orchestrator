# MCP Integration

MCP tools are represented by `mcp_tool` nodes and exposed to agents as callable tool definitions.

## Built-in MCP adapters

- `http_mcp`: real endpoint integration
- `mock-mcp`: demo tools for local validation

## How it works

1. Configure MCP node endpoint/auth
2. Discover tool list from server
3. Select one, many, or all tools
4. Attach MCP node(s) to agent `tool` port
5. Agent runtime passes tool schemas to model
6. Model invokes tools dynamically during loop

## Best practices

- Keep selected tool set minimal per workflow
- Use concise tool descriptions
- Validate discovery output before enabling `all tools`
