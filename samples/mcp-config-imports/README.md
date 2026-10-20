# MCP client config import fixtures

MCP client config files in the shapes the registry importer reads
(`apps/api/src/services/mcp-config-import.ts`, used by
`POST /api/mcp/servers/import` and the **Import config** dialog on the MCP
servers page). Every credential in them is a fake fixture value.

Each `<name>.json` / `<name>.jsonc` is a source file. Each
`<name>.expected.json` is the converter's golden output: the detected format,
the preview of every entry (adapter, connection without secret values, value
slots, field report, decision) and, under `materialized`, the connection and
secret names each entry is stored with once every missing value is supplied.
`apps/api/src/services/mcp-config-import.test.ts` compares them verbatim and
also checks that no fixture credential appears in a preview or a stored
connection.

| Fixture | Covers |
|---|---|
| `mcp-servers` | Top-level `mcpServers`: pinned and unpinned `npx` servers, one secret env var (single secret), two secret env vars (secret bundle), a remote server with a bearer `Authorization` header and a plain header, a legacy SSE URL turned off in the file, an entry with neither command nor URL, `autoApprove` |
| `workspace-mcp` | Workspace `servers` + `inputs`: a password input in env (secret), a plain input (prompted value), `${workspaceFolder}` in args, `envFile`, a bearer header built from an input, `type: "sse"`; JSONC comments and trailing commas |
| `cli-agent-settings` | `mcpServers` inside a larger settings file: `httpUrl`, `${VAR}` and `${env:VAR}` references, `${HOME}`, `timeout`, `cwd`, `trust`, `includeTools`, a database URL with a password in the arguments |
| `editor-settings` | `context_servers` with `command: { path, args, env }` and `settings` blocks |
| `typed-map` | `mcp` map with `type: "local"` (command array, `environment`) and `type: "remote"` (Basic `Authorization`, so a secret bundle), `enabled: false` |
| `user-settings` | `mcp.servers` + `mcp.inputs` in a JSONC user settings file: a `pickString` input with options and a default, two literal secrets |
| `per-project` | `mcpServers` plus `projects.<path>.mcpServers`, with a name clash between the two |

After an intentional converter change, regenerate the goldens and review the diff:

```bash
UPDATE_MCP_IMPORT_GOLDENS=1 pnpm --filter @ai-orchestrator/api exec vitest run src/services/mcp-config-import.test.ts
```
