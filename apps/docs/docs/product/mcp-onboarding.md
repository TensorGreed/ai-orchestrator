# MCP onboarding and catalog

Three tools help you get MCP servers into L2M and try them out:

- **Import config** turns the MCP client config files your team already has into registered servers in one step. Credentials become secrets.
- The **catalog file** is a list of approved servers, with pinned package versions, that you keep next to your deployment. It feeds the presets on the registration form and can restrict which local commands admins may register.
- The **Playground** calls any tool of a registered server through a form built from the tool's input schema, and shows the JSON-RPC exchange.

Everything runs on your own instance. L2M never fetches a catalog or a config from the network.

## Import client config files

Under **MCP → Servers**, choose **Import config**, then drop a file, choose one, or paste its JSON. L2M shows a preview of every server entry before anything is saved:

- the adapter and connection it maps to (`stdio_mcp` for local commands, `http_mcp` for remote URLs);
- which values become **secrets** and which values you still need to enter;
- whether the entry matches a server that is already registered;
- a report of fields that were mapped, approximated or skipped.

Admins import. Builders can open the dialog and preview a file, which is useful to check what a teammate's config would bring in. After the import, each new server is probed like a normal registration, unless the file had turned it off.

### Supported files

The importer reads JSON. Comments and trailing commas are allowed, so editor settings files work as they are.

| Shape | Where you find it |
|---|---|
| Top-level `mcpServers` object | `mcp.json` files of desktop assistants, IDE agents and command-line agents. Sections nested per project under `projects.<path>.mcpServers` are imported too, with the project folder appended to clashing names. |
| `servers` plus `inputs` | A workspace `.vscode/mcp.json`. |
| `mcp.servers` plus `mcp.inputs` | The same entries inside a user `settings.json`. |
| `context_servers` | Editor settings where each server has `command: { path, args, env }`. |
| `mcp` map with `type: "local"` or `"remote"` | Configs where `command` is an array and env vars are under `environment`. |

Within an entry, the importer accepts the common spellings of each setting:

| Setting | Spellings |
|---|---|
| Local command | `command` (string, array, or `{ path, args, env }`), `args`, `env` or `environment`, `cwd` |
| Remote URL | `url`, `serverUrl`, `httpUrl`, `endpoint`; `headers` |
| Transport | `type` or `transport`: `stdio`, `local`, `http`, `streamable-http`, `remote`, `sse` |
| Timeout | `timeout` in milliseconds (values under 1000 are read as seconds) |
| Off switch | `disabled: true` or `enabled: false` (imported with probing off) |

An `mcpServers` example with a local server and a remote one:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…", "GITHUB_API_URL": "https://api.github.example.com" }
    },
    "docs-search": {
      "type": "http",
      "url": "https://mcp.docs.example.com/mcp",
      "headers": { "Authorization": "Bearer …", "X-Workspace": "engineering" }
    }
  }
}
```

A workspace `mcp.json` with prompted inputs:

```json
{
  "inputs": [
    { "type": "promptString", "id": "tracker-key", "description": "Issue tracker API key", "password": true },
    { "type": "promptString", "id": "tracker-project", "description": "Default project key" }
  ],
  "servers": {
    "tracker": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tracker-mcp@3.2.0"],
      "env": { "TRACKER_API_KEY": "${input:tracker-key}", "TRACKER_PROJECT": "${input:tracker-project}" }
    }
  }
}
```

More examples, one per shape, are in `samples/mcp-config-imports/` together with the converter's output for each.

### How credentials are handled

A value is treated as a credential when:

- its env var or header name contains `token`, `key`, `secret`, `passw`, `pwd`, `auth`, `credential` or `cookie` (so `Authorization`, `X-Api-Key` and `GITHUB_TOKEN` all count);
- it is a `${input:…}` placeholder whose input is marked `"password": true`;
- it is a `${env:NAME}` or `${NAME}` reference and either name looks like a credential.

Credentials are stored through the secret store (AES-256-GCM at rest) and the server references them by secret id. The raw value is never written to the server's connection, never returned by the preview or the import response, and never recorded in logs or audit events, which list secret names only.

Values that are not in the file have to be entered in the dialog before the entry can be imported:

- `${input:…}` placeholders. Password inputs become secrets. Other inputs are plain values kept in the connection; a `pickString` input shows its options and default.
- `${env:NAME}` and `${NAME}` references. They point at the environment of the machine the file came from, which L2M cannot read, so you type the value.

How the secret is wired depends on how many credentials a server has:

| Case | Stored as |
|---|---|
| Local server, one secret env var | One secret; the connection names it in `secretEnvVar`. |
| Remote server, one `Authorization: Bearer …` header | One secret holding the token; the connection uses `authType: "bearer"`. |
| Several secret env vars, or secret headers other than a bearer token | One **secret bundle**: a secret whose value is a JSON object such as `{"API_KEY": "…", "API_SECRET": "…"}`. The connection lists the names in `secretEnvVars` (local) or `secretHeaders` (remote). |

When the server starts or is called, L2M resolves the bundle and injects each listed name into the child process environment or the request headers. You can use bundles for servers you register by hand too: create a secret whose value is the JSON object, pick it as the server's secret and add `secretEnvVars` or `secretHeaders` to the connection. Values of a bundle are redacted from playground and gateway results like a single secret.

Things the importer cannot keep as secrets are reported instead of silently stored:

- A credential inside the command arguments, such as a database URL with a password. The argument stays in the connection as it is, the preview masks it, and the report asks you to move it to an env var.
- A `${input:…}` placeholder inside arguments, a URL or `cwd`. It is left verbatim for you to replace after the import.
- Client variables such as `${workspaceFolder}` or `${userHome}`. They describe the client machine; adjust them for the L2M host.

### Duplicates

An entry matches a registered server when it has the same command and arguments (local) or the same URL, ignoring case of the host, a trailing slash and fragments (remote). For a match you choose:

| Decision | Effect |
|---|---|
| Skip (default) | Nothing changes. |
| Update | The registered server gets the imported adapter, connection and a new secret; its name, owner and probe settings stay. The previous secret is kept in the secret store, since other servers may use it. |
| Create a copy | A new server named `<name> (imported)`. |

Entries without a match are created. A name that is already taken by an unrelated server gets the same `(imported)` suffix.

### What is not imported

Each entry's report lists these as skipped, with the reason:

| Field | Why |
|---|---|
| `autoApprove`, `alwaysAllow`, `trust` | L2M decides tool access with [tool policies](./mcp-tool-policy) and read-only classification. |
| `includeTools`, `excludeTools`, `tools` | Express them as tool policy rules for the server. |
| `envFile` | The file lives on the client machine. Add the values as env vars or secrets. |
| `oauth`, `auth` blocks | Configure authentication on the registered server. |
| Server `settings` blocks, `dev`, `gallery`, `version` | No registry equivalent. |
| `type: "sse"` | Registered as Streamable HTTP; servers that only speak the legacy SSE transport fail their first probe. |

## Deployment catalog

Set `MCP_CATALOG_FILE` to the path of a JSON file that lists the servers your deployment approves. The file is read on start, again whenever it changes (L2M polls it every two seconds, so replacing it or updating a mounted volume works), and on demand with **Reload** on the MCP servers page or `POST /api/mcp/catalog/reload`.

`samples/mcp-catalog.example.json` is a starting point:

```json
{
  "version": 1,
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem (shared drive)",
      "description": "Read and write files under /srv/shared only.",
      "adapter": "stdio_mcp",
      "connection": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "/srv/shared"]
      },
      "tags": ["Files"],
      "approved": true
    },
    {
      "id": "warehouse",
      "name": "Data warehouse",
      "adapter": "stdio_mcp",
      "connection": {
        "command": "docker",
        "args": ["run", "-i", "--rm", "-e", "WAREHOUSE_API_KEY", "registry.internal/warehouse-mcp:1.4.0"],
        "secretEnvVar": "WAREHOUSE_API_KEY"
      },
      "requiredSecrets": [{ "name": "WAREHOUSE_API_KEY", "description": "Service account key" }],
      "approved": true
    }
  ]
}
```

### Entry fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase letters, digits, `.`, `_` and `-`; unique in the file. |
| `name` | yes | Shown in the preset list. |
| `description` | no | Shown under the preset. |
| `adapter` | yes | `stdio_mcp` or `http_mcp`. |
| `connection` | yes | The connection template: `command` and `args` for local servers, `endpoint` for remote ones, plus any other connection setting. |
| `requiredSecrets` | no | `[{ name, description }]`: the env vars or headers the server needs. Shown as a hint on the registration form. |
| `tags` | no | The first tag is the preset's category. |
| `approved` | no, default `false` | Only approved entries appear as presets and satisfy enforcement. |
| `notes`, `source` | no | Shown with the preset. |

Local entries must **pin the package they run** to an exact version. L2M recognises the usual package runners:

| Runner | Pinned | Not pinned |
|---|---|---|
| `npx`, `bunx`, `pnpx`, `pnpm dlx`, `yarn dlx` | `@scope/pkg@1.2.3` | `@scope/pkg`, `pkg@latest`, `pkg@^1.2.0` |
| `uvx`, `uv tool run`, `pipx run` | `pkg==1.2.3`, `--from pkg==1.2.3` | `pkg`, `pkg>=1.2` |
| `docker run`, `podman run` | `image:1.4.0`, `image@sha256:…` | `image`, `image:latest` |

Any other command (a binary or script path such as `node /opt/server.js`) counts as pinned by its path.

### Validation and errors

Each entry is validated on its own: an invalid or unpinned entry is left out and reported, and the others load. A file that cannot be read or is not valid JSON is reported as a whole, and the last good catalog stays in use. Errors never stop the API. The MCP servers page shows the catalog's state, its counts and the first errors with the entry index and field, so a broken file is visible without reading server logs.

### Modes

| `MCP_CATALOG_MODE` | Presets on the registration form |
|---|---|
| `merge` (default) | Approved catalog entries first, then the built-in presets. |
| `exclusive` | Approved catalog entries only. |

Without `MCP_CATALOG_FILE`, the built-in presets are listed as before.

### Enforcement

With `MCP_CATALOG_ENFORCE=true`, admins can only register, update or import a **local (stdio) server** whose command matches an approved catalog entry:

- for package runners, the same runner and exactly the same pinned package (trailing arguments such as directories are free);
- for other commands, the same command and the same first argument (the script).

Anything else is refused with the reason: an unpinned package, another version, an unapproved entry or an unknown command. In merge mode, built-in presets the catalog does not cover are hidden. If enforcement is on and no approved entries are loaded, every stdio registration is refused.

Why: a stdio server is a process L2M starts on its own host, with the host's network and file access. An unpinned `npx -y some-package` runs whatever version the registry serves at that moment, so a compromised or typo-squatted release would run inside your deployment. Enforcement limits local processes to packages someone reviewed, at the version they reviewed. Remote servers run elsewhere and stay governed by [tool policy](./mcp-tool-policy), so enforcement does not apply to them. Existing servers are not re-checked until their connection is edited.

## Playground

The **MCP → Playground** page is for builders and admins. Pick a registered server and one of the tools from its current snapshot (probe the server first if it has none). The tool list shows each tool's read-only or write classification and whether tool policy blocks it for you.

Arguments are entered through a form generated from the tool's input schema:

| Schema | Control |
|---|---|
| `string` (with `format: email` / `uri` where given) | Text input; a text area for long text fields |
| `number`, `integer` | Numeric input, checked against `minimum` / `maximum` |
| `boolean` | Checkbox when required, otherwise not set / true / false |
| `enum`, `const` | Select |
| Array of strings, numbers or booleans | A list with add and remove |
| Array of enum values | Toggle chips |
| Nested `object` with properties | A group of fields, nested up to four levels |
| Anything else (`anyOf`, `oneOf`, arrays of objects, free-form objects) | A JSON editor for that property |

**Edit as JSON** switches the whole form to a JSON editor, and a tool whose schema is not an object with properties always uses it. Required fields, numbers and JSON are checked before the call is sent.

When you call a tool:

- it runs through the registry like an agent's call: the server's stored connection, secrets injected on the server side, and an unaccepted breaking change blocks the call;
- [tool policy](./mcp-tool-policy) is evaluated for **your** role and the active project; a blocked tool returns the rule that blocks it. A server that belongs to a project is always evaluated in that project, and you need permission to run workflows there;
- a tool classified as **write** asks for confirmation first;
- the call is recorded in the server's telemetry with source `playground` and in the audit log (`mcp_tool.playground_call`, tool name, outcome and duration; arguments and results are not audited).

The result shows the content blocks (text, images, other blocks as JSON), the structured content when there is any, the duration, and a **JSON-RPC exchange** panel: the transport (command and env names, or endpoint and headers) with every credential masked, the `tools/call` request as L2M sends it, and the result in `tools/call` form as the adapter returned it.

Your last 20 calls are kept in this browser only (per user); click one to load its arguments again.

### Resources and prompts panels

The playground has a panel per server capability. **Resources** lists what the server published at its last probe: plain resources, resource templates (`notes://{date}` gets an input per placeholder) and **Any URI…** for a URI you type. **Read resource** fetches it through the registry, under the policy's resource rules, and shows text (with a formatted view for JSON) or, for binary contents, an image preview and a download link. **Prompts** lists the server's prompts with their arguments; **Preview prompt** renders the messages the server returns for the values you enter. Both panels have **Refresh list**, which lists again without waiting for a probe, and both mark entries your role may not use. Reads and previews are audited (`mcp_resource.read`, `mcp_prompt.get`) with the URI or prompt name only.

If a tool asks a question while you call it from the playground, the request is declined: the playground does not pause for input. Run the workflow from the editor to answer such questions.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_CATALOG_FILE` | empty | Path to the catalog JSON. Empty: built-in presets only. |
| `MCP_CATALOG_MODE` | `merge` | `merge` or `exclusive`. |
| `MCP_CATALOG_ENFORCE` | `false` | Restrict stdio registrations and imports to approved, pinned catalog entries. |

## API

| Endpoint | Role | Purpose |
|---|---|---|
| `POST /api/mcp/servers/import` | admin; builder with `dryRun` | Preview or import a client config. Body: `content` (text or object), `fileName`, `dryRun`, `projectId`, `probe`, and `entries` keyed by entry name with `decision`, `name` and `values` (slot id → value). Audit event `mcp_server.imported`. |
| `GET /api/mcp/presets` | viewer | Presets with `origin` (`builtin` or `catalog`) and the catalog status. |
| `GET /api/mcp/catalog` | builder | Catalog status and entries. |
| `POST /api/mcp/catalog/reload` | admin | Re-read the file now. Audit event `mcp_catalog.reloaded`. |
| `POST /api/mcp/servers/:id/playground/call` | builder | Call a tool: `toolName`, `args`, `projectId`, `confirmWrite`. 403 when policy blocks it, 409 when a write tool needs confirmation. |
| `GET /api/mcp/servers/:id/resources` | builder | Resources and templates from the catalog; `refresh=true` lists them again. |
| `POST /api/mcp/servers/:id/resources/read` | builder | Read one resource: `uri`, `projectId`. |
| `GET /api/mcp/servers/:id/prompts` | builder | Prompts from the catalog. |
| `POST /api/mcp/servers/:id/prompts/get` | builder | Render one prompt: `name`, `arguments`, `projectId`. |

See also the [endpoint reference](../api/endpoints#mcp-onboarding).
