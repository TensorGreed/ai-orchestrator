---
title: "The mcpServers JSON config format, explained"
sidebarTitle: "mcpServers JSON config"
description: "What each field in an MCP client config does (command, args, env, url, headers, inputs) and how to move servers between clients without leaking secrets."
level: beginner
related: [mcp-server, mcp-client, stdio-transport, streamable-http, secret-reference]
---

# The mcpServers JSON config format

An MCP client config is a JSON file that maps a server name to either a command the client starts (`command`, `args`, `env`) or a URL it connects to (`url`, `headers`). The MCP specification does not define this file; it is a convention that clients share, with small differences in key names and nesting. Move a server from one file to another by copying the command or URL as it is, and the credentials as references, never as pasted values.

## The basic shape

Most files keep their servers under a top-level `mcpServers` object. Each key is a name you choose, and each value describes one <Term id="mcp-server">MCP server</Term>:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@2.3.0", "/srv/shared"]
    },
    "docs-search": {
      "type": "http",
      "url": "https://mcp.docs.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:DOCS_TOKEN}" }
    }
  }
}
```

The first entry is a local server. The client starts `npx` as a child process and talks to it over <Term id="stdio-transport">stdio</Term>: JSON-RPC on the process's stdin and stdout. The second entry is a remote server the client reaches over <Term id="streamable-http">Streamable HTTP</Term>. The name (`filesystem`, `docs-search`) is only a label. Clients show it in their UI and logs.

## Fields of a local (stdio) server

| Field | What it does |
|---|---|
| `command` | The program to start: `npx`, `uvx`, `docker`, `node`, or an absolute path to a binary. |
| `args` | The arguments, as a list. Each item is one argument. |
| `env` | Extra environment variables for the process, usually API keys and settings. |
| `cwd` | Working directory for the process, in the files that support it. |
| `type` | `"stdio"` where a file wants it said explicitly. Most files infer it from `command`. |

Arguments often carry the server's configuration. The reference filesystem server takes its allowed directories as arguments, and the git server takes `--repository <path>`. That makes `args` part of the security setup, not just the launch line. See [Filesystem MCP server: safe setup](/learn/mcp-servers/filesystem-mcp-server) and [Git MCP server](/learn/mcp-servers/git-mcp-server).

Pin the package version in `args`. `npx -y @modelcontextprotocol/server-filesystem` runs whatever version the npm registry serves on that day. `@modelcontextprotocol/server-filesystem@2.3.0` runs the version you reviewed. The same goes for `uvx` (`mcp-server-git==2026.11.11`) and container images (`image:1.4.0`, or better, a digest).

## Fields of a remote server

| Field | What it does |
|---|---|
| `url` | The server's endpoint, for example `https://mcp.example.com/mcp`. Some files spell it `serverUrl` or `httpUrl`. |
| `type` | `"http"` (also `"streamable-http"` or `"remote"`) for Streamable HTTP; `"sse"` for the older HTTP+SSE transport. |
| `headers` | Fixed request headers, most often `Authorization`. |

A URL ending in `/sse` usually points at the legacy SSE transport. Newer servers serve Streamable HTTP on a single endpoint such as `/mcp`. [MCP transports](/learn/mcp/transports) explains the difference.

## Placeholders and inputs

Hard-coding a token in `env` or `headers` is the most common way secrets leak: the file gets committed, pasted into a chat or attached to a ticket. Many config files offer placeholders instead.

| Placeholder | Meaning |
|---|---|
| `${env:NAME}` or `${NAME}` | The value of an environment variable on the machine that reads the file. |
| `${input:id}` | A value the client asks the user for, defined in an `inputs` list. |
| `${workspaceFolder}`, `${userHome}` and similar | Paths the client fills in for the current workspace or user. |

An `inputs` list declares the prompted values. `"password": true` marks one as secret, so the client hides it while it is typed:

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
      "env": {
        "TRACKER_API_KEY": "${input:tracker-key}",
        "TRACKER_PROJECT": "${input:tracker-project}"
      }
    }
  }
}
```

A file written this way can be shared, because it holds no credential at all.

## The other shapes

The `mcpServers` object is the most common shape, but not the only one. These are the shapes in use, as a converter has to read them:

| Shape | Where you find it |
|---|---|
| Top-level `mcpServers` | Desktop assistants, IDE agents and CLI agent settings. Some CLI agent settings also nest servers per project under `projects.<path>.mcpServers`. |
| `servers` plus `inputs` | A workspace config file kept in the repository. |
| `mcp.servers` plus `mcp.inputs` | The same entries inside a user settings file, often JSON with comments. |
| `context_servers` | Editor settings. `command` is either a string with `args` beside it, or an object: `{ "path": "uvx", "args": [...], "env": {...} }`. |
| `mcp` map with `type: "local"` or `"remote"` | `command` is one array (`["npx", "-y", "pkg"]`) and env vars sit under `environment`. |

Two more differences to expect. A timeout may be in milliseconds or seconds, depending on the client. A server can be turned off with `"disabled": true` in one file and `"enabled": false` in another.

Some fields are client policy rather than connection details: `autoApprove`, `alwaysAllow` and `trust` skip the user's confirmation for some tools, and `includeTools`, `excludeTools` and `tools` filter the tool list. They do not travel well. A tool another client auto-approved is not automatically safe in a shared agent runtime.

## Moving servers without leaking secrets

Copying an entry from one file to another is easy. Copying it without spreading credentials takes four habits:

1. **Keep credentials out of `args`.** `postgresql://report:password@db:5432/sales` as an argument ends up in process lists and logs. Move it to an env var the server reads.
2. **Use placeholders, not values.** `"Authorization": "Bearer ${env:DOCS_TOKEN}"` can be committed; `"Bearer eyJ…"` cannot.
3. **Translate client variables.** `${workspaceFolder}` means something on a laptop and nothing on a server. Replace it with a real path on the machine that runs the server.
4. **Re-decide approvals.** Do not carry `autoApprove` lists across. Decide what needs a person's approval where the agent runs.

## Importing a config into L2M

L2M, a self-hosted agent runtime, can read these files directly. Under **MCP → Servers**, choose **Import config** and drop a file or paste its JSON. All five shapes above are recognised, and JSON with comments and trailing commas is accepted. Nothing is saved before you see a preview of every entry. The [MCP onboarding](/product/mcp-onboarding#import-client-config-files) reference has the full details; this is what happens to each field.

**Transport.** An entry with `command` becomes a `stdio_mcp` server; one with a URL becomes an `http_mcp` server using Streamable HTTP. A `command` written as one string with spaces (`"npx -y pkg"`) and no `args` list is split on spaces, and the report asks you to check the quoting. A `type: "sse"` entry is registered as Streamable HTTP too, with a warning: a server that only speaks the legacy SSE transport fails its first probe.

**Credentials.** A value is treated as a credential when its env var or header name contains `token`, `key`, `secret`, `passw`, `pwd`, `auth`, `credential` or `cookie`, or has `pat` as a separate part (`Authorization`, `X-Api-Key` and `GITHUB_TOKEN` all count), when it is an `${input:…}` whose input is marked `"password": true`, or when it is an `${env:…}` reference whose name looks like a credential. Credentials go to the [secret store](/security/secrets), encrypted at rest, and the server refers to them by <Term id="secret-reference">secret id</Term>. The raw value is never written to the connection, never returned by the preview and never recorded in audit events, which list secret names only.

- One secret env var on a local server, or one `Authorization: Bearer …` header on a remote one, becomes a single secret.
- Anything else becomes one **secret bundle**: several credentials, or a remote server's single header that is not a bearer token (an `X-Api-Key`, say). A bundle is a secret whose value is a JSON object, with the names listed in `secretEnvVars` or `secretHeaders`.

**Values L2M cannot know.** `${input:…}` and `${env:…}` placeholders refer to the person or the machine the file came from. In an env var or a header, the dialog asks you to type the value before the entry can be imported. Password inputs, and inputs that fill a credential-named env var or header, become secrets; other inputs stay plain values in the connection. In `args`, `cwd` or the URL, a placeholder is kept verbatim and flagged for you to replace after the import.

**What is reported instead of stored.** A credential inside `args` stays in the connection as it is. The preview masks it, and the report asks you to move it to an env var. Client variables like `${workspaceFolder}` are kept verbatim and flagged for you to adjust. `autoApprove`, `alwaysAllow`, `trust`, the tool filters, `envFile`, `oauth` and `auth` blocks and server `settings` blocks are skipped, each with the reason. One gap the report does not flag: in the `context_servers` shape, env vars nested inside the `command` object are not carried over, so add them to the server after the import.

Here is what the importer reports for an entry with two keys and an `autoApprove` list, trimmed from the golden output in `samples/mcp-config-imports/` (the full entry also lists the slots and the field report):

```json
{
  "key": "warehouse",
  "adapterId": "stdio_mcp",
  "connection": {
    "command": "uvx",
    "args": ["warehouse-mcp==0.4.1", "--readonly"],
    "env": { "WAREHOUSE_REGION": "eu-west-1" },
    "secretEnvVars": ["WAREHOUSE_API_KEY", "WAREHOUSE_API_SECRET"]
  },
  "secretMode": "bundle",
  "status": "approximated"
}
```

The region stays a plain env var. Both keys left the connection for a secret bundle. The entry is "approximated" rather than "mapped" because `autoApprove` was skipped.

**Duplicates.** An entry matches a registered server when the command and arguments are the same (local) or the URL is the same, ignoring host case, a trailing slash and fragments (remote). The default for a match is **Skip**; you can choose **Update** or **Create a copy** instead.

**Who can import.** Admins import. Builders can open the dialog and preview a file, which is a safe way to check what a teammate's config would bring in. Through the API, `POST /api/mcp/servers/import` with `"dryRun": true` returns the same preview.

## After the import: approvals belong in tool policy

Since auto-approve lists are not imported, decide again which tools need a person. In L2M that is optional and lives in two places:

- [MCP tool policy](/product/mcp-tool-policy) rules allow, deny or require approval per server and tool. A tool that no rule matches is allowed.
- The workflow's [Ask before write tools](/product/approvals#approval-before-write-tools) switch pauses an agent before any tool an admin has not marked read-only.

If your deployment keeps a [catalog of approved servers](/product/mcp-onboarding#deployment-catalog) with `MCP_CATALOG_ENFORCE=true`, an imported local server must match an approved, pinned catalog entry. An entry such as `npx -y some-package` without a version is refused with the reason, so unpinned commands cannot slip in through an import.

## Test it

The importer is a pure converter, and `samples/mcp-config-imports/` holds one source file per shape next to its expected output. To check your own file without touching a live server, preview it as a builder (dry run) and read the field report. After the import, each new server is probed like any registration, unless the file had turned it off. To test workflows that use it without calling it, record a <Term id="cassette">cassette</Term> or run a <Term id="snapshot-mock">snapshot mock</Term> as described in [Test MCP servers in CI](/guides/test-mcp-servers-in-ci).

## Try it in L2M

The [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) runs an agent against the built-in mock MCP server with no API key. Once it works, import your own config file and swap the mock for one of your servers.

## Further reading

- [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers) (modelcontextprotocol.io): a worked `mcpServers` example with `command`, `args` and `env`
- [MCP specification: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (modelcontextprotocol.io)
- In L2M: [MCP onboarding](/product/mcp-onboarding), [MCP server registry](/product/mcp-server-registry), [Secrets](/security/secrets)
- Related guides: [MCP transports](/learn/mcp/transports), [Filesystem MCP server](/learn/mcp-servers/filesystem-mcp-server)
