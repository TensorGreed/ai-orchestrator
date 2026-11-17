---
title: "Filesystem MCP server: safe setup for AI agents"
sidebarTitle: "Filesystem MCP server"
description: "Run the reference filesystem MCP server for an agent: allowed directories, read-only use, write approvals and the path checks that keep it contained."
level: intermediate
related: [mcp-server, stdio-transport, write-tool, tool-annotations, least-privilege, mcp-tool-policy]
---

# Filesystem MCP server: safe setup for AI agents

The reference filesystem MCP server gives an agent tools to read, search, write and move files, but only inside the directories you pass on its command line. For a safe setup, give it the narrowest directories the task needs, start it with `--read-only` unless the agent must write, and put a person's approval in front of the write tools you do enable. Run a current version: its path checks have had several published security fixes.

## What the server does

The server is `@modelcontextprotocol/server-filesystem` on npm, maintained in the `modelcontextprotocol/servers` repository under `src/filesystem`. As of November 2026 it is an active reference server (it was not moved to the archive repository), the latest npm release is 2.3.0 (published 2026-11-11), and it needs Node.js 24 or later when run through `npx`. It speaks <Term id="stdio-transport">stdio</Term> only, and serves both 2025-era clients (`initialize`) and 2026-07-28 clients (`server/discover`).

Its tools split cleanly into readers and writers. Every tool carries <Term id="tool-annotations">tool annotations</Term>, and every one sets `openWorldHint: false`, since the server touches only the local disk:

| Tools | `readOnlyHint` | Notes from the README |
|---|---|---|
| `read_text_file`, `read_media_file`, `read_multiple_files`, `list_directory`, `list_directory_with_sizes`, `directory_tree`, `search_files`, `get_file_info`, `list_allowed_directories` (and `read_file`, a deprecated alias) | `true` | Pure reads. `search_files` matches names, not contents. |
| `create_directory` | `false` | Not destructive; re-creating a directory is a no-op. |
| `copy_file` | `false` | Never overwrites; a repeat fails and changes nothing. |
| `append_file` | `false` | Not destructive, but repeating it appends again. |
| `write_file` | `false` | Destructive: overwrites an existing file. |
| `edit_file` | `false` | Destructive. Has a `dryRun` option that returns a diff. |
| `move_file` | `false` | Destructive: the source is removed. |

Files in the allowed directories are also readable as MCP resources through the template `file://{+path}`, confined the same way as the tools. `resources/list` returns nothing; the server never enumerates the disk on its own.

## Allowed directories come from the command line

The server may touch only its **allowed directories**. You pass them as arguments:

```bash
npx -y @modelcontextprotocol/server-filesystem@2.3.0 /srv/shared/reports /srv/shared/templates
```

There is a second way in the protocol. MCP **roots** let a client tell a server which `file://` locations it may work in: a client declares the `roots` capability, and the server asks with `roots/list`. With a 2025-era client that declares roots, this server replaces its command-line directories with the client's roots, unless you start it with `--confine-roots`, which keeps roots inside the command-line directories. Roots are deprecated as of protocol version 2026-07-28 ("Pass directories or files via tool parameters, resource URIs, or server configuration"), and a 2026-07-28 connection cannot use them.

**What this means in L2M.** L2M does not declare the roots capability, in either protocol era. The capabilities it sends in `initialize` are `elicitation` and, when sampling is available for the call, `sampling`; on 2026-07-28 connections it refuses `roots/list` input requests. So with L2M the arguments in the server's connection are the whole allow-list, and nothing at run time can widen them. Two consequences:

- Start the server with at least one directory. On an `initialize` connection (L2M's default `legacy` [protocol mode](/product/mcp-2026-07-28#protocol-modes)), a server with no directories and a client without roots logs the reason, closes the connection and exits with status 1. On a 2026-07-28 connection it answers every tool call with an error.
- `--confine-roots` has no effect for L2M, because no roots ever arrive. It does no harm either.

To check what the server actually got, call `list_allowed_directories`, or read the server's stderr: it logs the effective directories at startup.

## Read-only use first

Most agent tasks only read: summarise a report, find a template, answer from a folder of notes. For those, start the server with `--read-only`:

```bash
npx -y @modelcontextprotocol/server-filesystem@2.3.0 --read-only /srv/shared/reports
```

The server then registers only the tools annotated `readOnlyHint: true`. The write tools are not listed at all, and a call to one fails as an unknown tool. The server enforces this itself, whatever the client allows.

When an agent must write somewhere but only read elsewhere, mark the reference directories with `--read-only-dir`:

```bash
npx -y @modelcontextprotocol/server-filesystem@2.3.0 \
  --read-only-dir /srv/shared/templates /srv/work/drafts
```

The write tools stay listed but refuse any target inside `/srv/shared/templates`. The check runs on the resolved path, so a symlink in `/srv/work/drafts` cannot route a write into the protected directory. The README also recommends enforcing read-only access a second time below the server, with file permissions or a read-only bind mount.

## Path checks and published advisories

Containment is the whole point of this server, and it is where its security reports cluster. The GitHub security advisories for `modelcontextprotocol/servers` include, for this package:

- **GHSA-hc55-p739-j48w** (CVE-2025-53110, published 2025-07-01): "access to unintended files in cases where the prefix matches an allowed directory." For example, a plain string prefix check treats `/srv/shared-secret` as inside `/srv/shared`.
- **GHSA-q66q-fx2p-7w4m** (CVE-2025-53109, same date): access to unintended files "via symlinks within allowed directories."
- Several advisories published in October and November 2026, fixed in 2.0.1 and 2.3.0: a trailing quote or space that passed the check but not the file operation (GHSA-7rgq-gccq-qphx), symlink and parent-directory races between the check and the use (GHSA-53mr-w429-c597, GHSA-p9cv-8g75-4xcg), and others. Several of them list the older date-numbered releases, up to 2026.8.31, as affected with no patched version in that line.

Three practical rules follow:

1. **Pin 2.3.0 or later.** An unpinned `npx -y @modelcontextprotocol/server-filesystem` runs whatever npm serves, and an old pinned date version stays vulnerable. The built-in **Filesystem** preset and the repository's `samples/mcp-catalog.example.json` both pin 2.3.0; move the pin forward when a newer release fixes another advisory.
2. **Do not rely on argument rules for containment.** A policy rule like "deny unless `path` starts with `/srv/shared`" is the same prefix check the first advisory was about, and it cannot see symlinks or hard links. Containment is the server's job, backed by the operating system.
3. **Mind hard links.** The README notes that the checks are path-based: if a file inside an allowed directory is hard-linked from elsewhere, writing it changes the content at every name. `get_file_info` reports a `hardLinks` count; more than 1 means the file has other names.

## Run it in L2M

Register the server once under **MCP → Servers**. There are three ways to get it in:

- **The Filesystem preset** on the registration form fills in the adapter and an `npx` connection pinned to `@modelcontextprotocol/server-filesystem@2.3.0`, with `/tmp` as the directory. Replace `/tmp` with your directories, and add `--read-only` for read-only use.
- **Your deployment catalog**, if you keep one (`MCP_CATALOG_FILE`). With `MCP_CATALOG_ENFORCE=true`, only approved, pinned packages can be registered as stdio servers; trailing arguments such as directories stay free. See [MCP onboarding](/product/mcp-onboarding#deployment-catalog).
- **Import config**, if the server is already in a client config file. See [The mcpServers JSON config format](/learn/mcp-servers/import-mcp-json-config).

A registered stdio connection looks like this:

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem@2.3.0", "--read-only", "/srv/shared/reports"],
  "timeoutMs": 60000
}
```

Then pick the server under **Registered server** on an MCP Tool node attached to the agent's `tool` port, or in the agent's server list. The [MCP server registry](/product/mcp-server-registry) probes it, stores its tool list as history and flags breaking changes.

**Contain the process, optionally.** By default a stdio server runs on the API host with the API's own permissions, so the directories must exist there. An admin can instead set the server's **Sandbox** to **Container** ([sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)). The command then runs in a throwaway container with a read-only root filesystem, a non-root user, no network and no host folders. Host folders can be mounted only from under `MCP_SANDBOX_ALLOWED_MOUNT_ROOTS`, which is empty by default, and each mount is read-only unless you tick **Writable**. Two things to plan for: the image must already contain the server, because `npx` cannot download a package without network; and the server's directory arguments are paths inside the container, so they must match the mount targets.

## Least privilege in L2M

Every setting below is optional. With none of them, every tool is allowed.

| Goal | Setting |
|---|---|
| The agent cannot write at all | Start the server with `--read-only`. Optionally also turn on the workflow's **No write tools** switch ([No write tools](/product/mcp-tool-policy#no-write-tools)), which blocks tools by their read-only classification. |
| A person approves every write | Turn on **Ask before write tools** ([approval before write tools](/product/approvals#approval-before-write-tools)). This gate trusts only an admin's marks, so mark the ten read tools **read-only** on the server's Tools table, or every call pauses. |
| Approval only for destructive writes | A `require_approval` tool policy rule on this server with the annotation condition **destructive** ([annotation conditions](/product/mcp-tool-policy#annotation-conditions)). It matches `write_file`, `edit_file` and `move_file`. |
| One role reads only | A deny rule for that role on this server with the condition **not_read_only**. |
| No moves, anywhere | A deny rule with pattern `move_file`. |

Because the server annotates every tool, L2M's [read-only classification](/product/mcp-tool-policy#read-only-classification) gets it right without overrides. Mark the tools anyway once you have reviewed them: an admin's mark wins over the server's hint, so a future release cannot reclassify a tool without you noticing. Annotation changes also appear in the registry's schema history.

An approval request shows the tool, the server and a preview of the arguments, so the person sees the `path` and, for `edit_file`, the edits. You can ask the agent to call `edit_file` with `dryRun: true` first. That call is still a write tool by its annotation, so it pauses too. With the policy rule (not the switch), add an allow rule for `edit_file` with the same server, roles and annotation condition plus the condition `dryRun` equals `true`. It is [strictly narrower](/product/mcp-tool-policy#evaluation-order), so it carves the preview out of the approval.

## Test it without touching files

Record a run with **Record MCP calls** on: every filesystem call, its arguments and its result are stored as a <Term id="cassette">cassette</Term>, with secrets redacted. **Replay** in strict mode answers every call from the cassette and never contacts the server, so a prompt change can be tested without reading or writing a file. For CI, export the server's accepted snapshot and run it as a stdio <Term id="snapshot-mock">snapshot mock</Term>:

```bash
pnpm l2m mcp snapshot export --server mcp_123 --out filesystem.snapshot.json
pnpm l2m mcp mock --snapshot filesystem.snapshot.json --cassette run.cassette.json
```

[Test MCP servers in CI](/guides/test-mcp-servers-in-ci) has the full steps, including `l2m mcp check`, which fails the build when the server's tools change in a breaking way.

## Try it in L2M

The [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) runs an agent against the built-in mock server with no API key and shows read-only classification at work. Once it runs, register the filesystem server with `--read-only` and point the agent at it.

## Further reading

- [Filesystem MCP server README](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md) (modelcontextprotocol/servers on GitHub)
- [GHSA-hc55-p739-j48w: path validation bypass via colliding path prefix](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-hc55-p739-j48w) and [all advisories for the servers repository](https://github.com/modelcontextprotocol/servers/security/advisories) (GitHub)
- [MCP specification 2025-11-25: Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots) and [Deprecated features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) (modelcontextprotocol.io)
- In L2M: [MCP server registry](/product/mcp-server-registry), [MCP tool policy](/product/mcp-tool-policy), [Approval gates](/product/approvals)
- Related guides: [MCP tool annotations](/learn/mcp/tool-annotations), [Least privilege for AI agents](/learn/security/least-privilege-for-agents), [Git MCP server](/learn/mcp-servers/git-mcp-server)
