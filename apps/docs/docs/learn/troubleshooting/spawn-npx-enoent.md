---
title: "\"spawn npx ENOENT\" when starting an MCP server"
sidebarTitle: "spawn npx ENOENT"
description: "The MCP client could not find npx, uvx or node on the PATH it launches servers with. Why it works in your terminal but not in the app, and how to fix it."
level: intermediate
about: stdio-transport
related: [stdio-transport, mcp-server, mcp-client, mcp-host, self-hosted]
---

# spawn npx ENOENT

`spawn npx ENOENT` means the program that launches your MCP server asked the operating system to start `npx` and the operating system found no such file. The server never ran: fix the command or the `PATH` the client launches it with, usually by giving an absolute path.

## What it means

A local MCP server uses the <Term id="stdio-transport">stdio transport</Term>: the <Term id="mcp-client">MCP client</Term> starts it as a child process. Clients written in Node.js do that with `child_process.spawn()`. When the process cannot be started, Node.js emits an `error` event instead of starting anything, and the error's message is `spawn <command> ENOENT`. `ENOENT` is the operating system's "no such file or directory". The same message appears for `spawn uvx ENOENT`, `spawn docker ENOENT` or `spawn node ENOENT`.

How Node.js finds the command matters. Its documentation says the lookup uses `options.env.PATH` when an `env` is passed, and `process.env.PATH` otherwise. If `env` is passed without a `PATH`, the lookup on Unix falls back to a default search path of `/usr/bin:/bin`. So the question is never "is npx installed?" but "is npx on the `PATH` of the process that launched the server?".

That `PATH` is often not your terminal's. Version managers and package managers (nvm, Homebrew and others) add their folders to `PATH` in your shell's startup files. An app started from a desktop launcher, a dock, a service manager or a container does not read those files, so it gets a shorter `PATH` that leaves those folders out. The command works when you type it and fails when the app runs it.

Clients also build the server's environment differently. The official TypeScript SDK's stdio client, for example, passes only a short list of variables, including `PATH`, and adds the server's own `env` on top (see [MCP server can't see API keys](/learn/troubleshooting/mcp-env-vars-not-passed) for the full list). Either way, a `PATH` you set in the server's `env` replaces the inherited one for the lookup.

## Causes (most to least likely)

1. **The runtime is installed in a folder the app's `PATH` does not include.** Typical for Node.js installed with a version manager, and for `uv` installed into a user folder.
2. **The runtime is not installed where the server runs.** A remote machine, a container image or a CI runner has no Node.js, Python or `uv`.
3. **Windows command shims.** `npx`, `npm` and many other commands are `.cmd` files on Windows. The Node.js documentation says `.bat` and `.cmd` files "are not executable on their own without a terminal", so spawning `npx` without a shell fails with `ENOENT` even when `npx` is on `PATH`.
4. **Command and arguments in one string.** With `"command": "npx -y @modelcontextprotocol/server-everything"`, the system looks for a single file with that whole name. Node.js reports `spawn npx -y @modelcontextprotocol/server-everything ENOENT`.
5. **A working directory that does not exist.** If the configured `cwd` is missing, Node.js still reports `spawn <command> ENOENT`, naming the command, not the folder.
6. **A replaced `PATH`.** The server's `env` sets `PATH` to something that leaves the runtime out.

A related case is not an `ENOENT` from spawn at all. If you give the absolute path of `npx` but `node` is not on `PATH`, the system finds `npx`, runs its first line (`#!/usr/bin/env node`), and that fails. The server exits at once with status 127 and this on stderr, which most clients report as a closed connection:

```text
/usr/bin/env: 'node': No such file or directory
```

## How to check

Find where the commands live, in the shell where they work:

```bash
command -v node npx uvx
```

```text
/home/me/.nvm/versions/node/v24.14.0/bin/node
/home/me/.nvm/versions/node/v24.14.0/bin/npx
/home/me/.local/bin/uvx
```

A path under your home folder is a strong sign that a launcher-started app will not see it. Then reproduce the failure with the `PATH` a desktop app or service is likely to have:

```bash
node -e "require('node:child_process').spawn('npx', ['--version'], { env: { PATH: '/usr/bin:/bin' } }).on('error', e => console.log(e.message))"
```

```text
spawn npx ENOENT
```

On Windows, run `where npx` in a command prompt. If the path it prints ends in `.cmd`, the client must start it through `cmd.exe` or a shell.

Also check the server entry itself: the command is one word or one path, the arguments are in their own list, and every folder it names (`cwd`, arguments) exists on the machine that runs the server.

## Fix

**Use absolute paths.** Point `command` at the runtime itself and make sure that runtime's folder is on `PATH` too, because `npx` starts `node` by name:

```json
{
  "command": "/home/me/.nvm/versions/node/v24.14.0/bin/npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/project"],
  "env": { "PATH": "/home/me/.nvm/versions/node/v24.14.0/bin:/usr/bin:/bin" }
}
```

**Or skip `npx`.** Install the server once (`npm install -g` or into a project folder) and run its entry script with the absolute path of `node`. This also avoids a download on every start.

**Or install the runtime system-wide.** A system package of Node.js or `uv` lands in `/usr/bin` or `/usr/local/bin`, which launcher-started apps usually have on `PATH`.

**On Windows**, set the command to `cmd` and the arguments to `/c`, `npx` and the rest, or use the absolute path of `node.exe` and the server's script.

**Split command and arguments.** `"command": "npx"`, `"args": ["-y", "@scope/server"]`.

**In containers**, the runtime has to be in the image. A slim Python image has no Node.js, and a Node.js image has no `uv`. Build an image with the server already installed, or use the server's published image.

## If you run agents in L2M

L2M's `stdio_mcp` adapter starts the configured `command` with its `args`, `env` and `cwd`. It reports a spawn failure in its own words, on the MCP server's page after a probe and in the run trace:

```text
MCP stdio process could not start: 'npx' was not found. Verify the command exists on PATH or pass an absolute path.
```

On Windows, L2M runs bare command names such as `npx`, and `.cmd` or `.bat` paths, through `cmd.exe` itself (quoting values that contain spaces or shell characters), so you do not need a `cmd /c` wrapper. That also changes what a missing command looks like there: `cmd.exe` starts, cannot find `npx` and exits, so you get `MCP stdio process exited unexpectedly. Last stderr: ...` with cmd's "is not recognized as an internal or external command" line. The "was not found" message, with a hint that `npx` and `npm` are `.cmd` shims, appears on Windows only for a command given as the path of a program, such as an `.exe` file. A `.cmd` or `.bat` path also runs through `cmd.exe`, so a wrong one shows up as the process exiting too.

Where the server starts decides which `PATH` applies:

- **On the API host (the default).** The server gets the API process's environment with the server's `env` merged on top. The lookup uses the API's `PATH`, so a `PATH` in the server's `env` replaces it. If the API runs as a service, its `PATH` is the service's, not your login shell's. If L2M runs from its Docker image, servers start inside the API container, which is based on a Node.js Alpine image: `node` and `npx` are there, `python3`, `uvx` and `docker` are not. A server that needs them fails with the message above until you extend the image or move the server elsewhere.
- **In a container sandbox (optional).** An admin can set a registered server's **Sandbox** to **Container**. The command then runs inside an image the admin supplies; L2M ships no sandbox images. The runtime and the server package must be in that image. The sandbox has no network by default and a read-only root filesystem, so `npx -y` cannot download a package at start: install it into the image. The container only gets the variables the server's config defines, and L2M refuses to pass reserved names such as `PATH` and `HOME` into it. See [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers).

On Linux and macOS, a missing `cwd` also produces "was not found" naming the command, as in Node.js, so check the folder when the command looks right.

Related errors: [MCP error -32000: Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed) for servers that start and then exit, and [MCP server can't see API keys or env variables](/learn/troubleshooting/mcp-env-vars-not-passed) for environment problems after the server starts. [MCP transports](/learn/mcp/transports) explains how stdio servers are launched, and [the mcpServers JSON config format](/learn/mcp-servers/import-mcp-json-config) what `command`, `args` and `env` mean when you move a server from a client config file.

## Further reading

- [Node.js: child_process.spawn()](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options) (nodejs.org)
- [Node.js: Spawning .bat and .cmd files on Windows](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows) (nodejs.org)
- [MCP specification, 2026-07-28: stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) (modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (github.com)
- In L2M: [MCP server registry](/product/mcp-server-registry#registering-a-server), [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers), [MCP onboarding: import client config files](/product/mcp-onboarding#import-client-config-files)
