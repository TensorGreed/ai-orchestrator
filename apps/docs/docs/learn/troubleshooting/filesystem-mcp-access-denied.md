---
title: "Filesystem MCP \"path outside allowed directories\" fix"
sidebarTitle: "Path outside allowed directories"
description: "Why the reference filesystem MCP server refuses a path: allowed directories, roots from the client, relative paths, symlinks and containers. Safe fixes."
level: intermediate
about: mcp-server
related: [mcp-server, mcp-tool, least-privilege, excessive-agency, stdio-transport]
---

# Access denied - path outside allowed directories

`Access denied - path outside allowed directories: <path> not in <dirs>` comes from the reference filesystem MCP server, `@modelcontextprotocol/server-filesystem`. It is the server doing its job: the requested path, once resolved, is not inside any directory the server was allowed to touch. Fix the path or the list of allowed directories, not the check.

## What it means

The filesystem server may read and write only inside its **allowed directories**. Before every file operation it turns the requested path into an absolute one, normalizes it, and checks that it lies inside one of them. If not, the tool call fails, and the message names both the path it checked and the directories it checked against:

```text
Access denied - path outside allowed directories: /home/me/notes.txt not in /srv/shared
```

Older versions put `Error: ` in front of the same text. The tail of the message is the most useful part. It shows the directories in force at that moment, which is often not what you expected.

There are two related messages. `Access denied - symlink target outside allowed directories` means the path is inside, but it is a symlink, or passes through one, whose real target is outside. Older versions also have `Access denied - parent directory outside allowed directories` for a new file whose parent folder resolves outside.

Where the allowed directories come from depends on the server version and the protocol:

- **Command-line arguments.** `mcp-server-filesystem /path/one /path/two`. The server's README calls this the recommended method and "the only method that works on every protocol version".
- **Roots from the client.** In the 2025-era protocol, a client that declares the `roots` capability can send a list of `file://` roots. The README says roots "completely replace any server-side Allowed directories when provided". Recent versions add `--confine-roots`, which keeps a client's roots inside the command-line directories. The 2026-07-28 revision deprecates Roots and suggests passing directories "via tool parameters, resource URIs, or server configuration" instead; a 2026-07-28 connection uses only the command-line directories.

## Causes (most to least likely)

1. **The client's roots replaced your list.** You started the server with `/home/me/project`, but the client sent its workspace folder as a root, so only that folder is allowed now.
2. **The path is on another machine's file system.** The server runs in a container, a VM or on a remote host, where your folder is mounted under another name (`/projects/app`) or not at all. The model asked for the host path.
3. **A relative path.** In older versions, such as the 2025.8.x releases, a relative path is resolved against the server process's working directory, which is wherever the client started it. Current versions resolve it against the allowed directories first.
4. **Symlinks.** The server resolves allowed directories to their real paths at startup. In older versions the requested path was compared as written, so where a folder is reached through a symlink (on macOS, `/tmp` is a link to `/private/tmp`), a path under the link name could be refused. The current README says both spellings are accepted. A symlink inside an allowed folder that points outside is refused in every version, on purpose.
5. **A typo or a `~`.** The folder does not exist, has different case, or a home-folder shortcut was not expanded where you expected.
6. **Windows paths.** Current versions refuse a Windows-style path sent to a server on Linux or macOS, and on Windows refuse alternate data stream paths (`file.txt:stream`) and reserved device names such as `CON`, by design.

## How to check

Ask the server. It has a `list_allowed_directories` tool that returns the directories in force:

```text
Allowed directories:
/srv/shared
```

Recent versions also log the effective directories to stderr at startup and whenever roots change, and say where they came from (the command line, or the client's roots).

Then compare that list with the path in the error, character by character, after resolving it the way the server does:

```bash
realpath /tmp/project       # on macOS prints /private/tmp/project
readlink -f ./notes/today.md
```

If the server runs in a container, list its mounts to see which host folder appears at which path inside:

```bash
docker inspect <container> --format '{{json .Mounts}}'
```

## Fix

- **Give absolute paths that exist where the server runs.** In a container, use the path inside the container, not on the host. Tell the agent that path in its instructions or let it call `list_allowed_directories` first.
- **Start the server with the exact folders it needs,** and nothing wider. Prefer `/home/me/project` over `/home/me`, and never `/`: the allow-list is the main safety boundary between a model and your files.
- **Control roots.** If your client sends roots, either point its workspace at the right folder or, in recent versions, start the server with `--confine-roots` so roots can narrow the command-line list but never widen it.
- **Use `--read-only` or `--read-only-dir`** in recent versions when the agent only needs to read. The server then refuses writes whatever the client allows.
- **Keep the server current.** Path confinement in this server has had several security fixes, from a 2025 advisory about directories sharing a name prefix to 2026 advisories about symlink swaps. Check the repository's security advisories and pin a fixed release.

## If you run agents in L2M

L2M does not declare the `roots` capability and answers a server's `roots/list` request with `-32601` (`Method not supported by this client: roots/list`). Under L2M, the allowed directories are therefore exactly the arguments in the server's connection, and nothing an agent does can widen them. The sample catalog in the L2M repository (`samples/mcp-catalog.example.json`) registers the filesystem server with one folder, `/srv/shared`, and a note to change it to the folders your deployment exposes. It pins release `2025.8.21`, which resolves relative paths against the working directory and predates the 2026 path-confinement fixes, so pin a current release when you copy it.

A few L2M specifics:

- The error arrives as a failed tool result, so the agent sees the text and can correct the path. It does not count against the server's [circuit breaker](/product/mcp-server-registry#rate-limits-concurrency-and-the-circuit-breaker), because the server answered.
- A stdio server starts in the connection's `cwd`, or the API process's working directory when `cwd` is empty. With older server versions, that is where relative paths point.
- Recent server versions given no directories exit at `initialize` when the client does not support roots, as L2M does not. With the default Legacy protocol mode, that shows as `MCP stdio process exited unexpectedly. Last stderr: ...` with the last lines the server logged (see [MCP error -32000: Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed)). In Auto or 2026-07-28 mode, the server stays up and every tool call fails with an error saying it has no allowed directories.
- Optionally, run the server in the [container sandbox](/product/mcp-server-registry#sandboxed-stdio-servers). Host folders can then be mounted only under `MCP_SANDBOX_ALLOWED_MOUNT_ROOTS`, which is empty by default (no mounts). L2M resolves each mount's symlinks and refuses one that escapes those roots. Mount the folder at a path inside the container, such as `/data`, read-only unless you tick **Writable**, and pass `/data` as the server's argument. That gives two boundaries: the container sees only the mount, and the server only its argument.
- [Tool policy](/product/mcp-tool-policy) can block the server's write tools for some roles, and [approvals](/product/approvals) can require a person to confirm a write. Both are optional.

Related errors: [MCP server connected but no tools show up](/learn/troubleshooting/mcp-server-shows-no-tools), and [-32601 Method not found](/learn/troubleshooting/json-rpc-32601-method-not-found) for what the roots refusal looks like from the server's side. For a full setup (version, folders, read-only use, attaching it to an agent), see the [filesystem MCP server guide](/learn/mcp-servers/filesystem-mcp-server). For why the allow-list matters, read [least privilege for AI agents](/learn/security/least-privilege-for-agents) and [MCP security risks](/learn/security/mcp-security-risks).

## Further reading

- [Filesystem MCP server README](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) (github.com)
- [Security advisories for modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers/security/advisories) (github.com)
- [MCP specification, 2025-11-25: Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Deprecated features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) (modelcontextprotocol.io)
- In L2M: [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers), [MCP tool policy](/product/mcp-tool-policy), [MCP onboarding and catalog](/product/mcp-onboarding#deployment-catalog)
