---
title: "MCP error -32000: Connection closed, causes and fixes"
sidebarTitle: "-32000 Connection closed"
description: "Why an MCP client reports -32000 Connection closed: the stdio server exited, never started or broke its stdout channel. How to find the cause and fix it."
level: intermediate
about: stdio-transport
related: [stdio-transport, mcp-server, mcp-client, model-context-protocol, mcp-host]
---

# MCP error -32000: Connection closed

`MCP error -32000: Connection closed` means the client lost the channel to the server before an answer arrived. With a local <Term id="stdio-transport">stdio</Term> server that almost always means the server process exited: it crashed on start, could not find something it needed, or quit on a message it did not expect, and the real reason is in its stderr output.

## What it means

With stdio, the <Term id="mcp-client">MCP client</Term> starts the <Term id="mcp-server">MCP server</Term> as a child process and exchanges one JSON-RPC message per line over the child's stdin and stdout. When the child exits, its stdout closes, and every request still waiting for an answer has to fail. The error you see is how the client reports that.

The number does not come from the server. JSON-RPC 2.0 reserves `-32000` to `-32099` for "implementation-defined server-errors". The MCP specification (2026-07-28) splits that range: `-32000` to `-32019` is legacy, codes that implementations allocated before the specification set a policy, and receivers "MUST NOT assume any specific meaning for these codes" apart from `-32002`. The specification also says errors that are local to an implementation, such as a timeout inside an SDK, have no assigned code.

The exact text comes from the official TypeScript SDK, version 1. Its `ErrorCode` enum lists `ConnectionClosed = -32000` and `RequestTimeout = -32001` under "SDK error codes", and its error class prefixes every message with `MCP error <code>:`. When the transport closes, the SDK fails each pending request with `Connection closed`. Version 2 of the SDK reports the same event as a local error with the string code `CONNECTION_CLOSED` instead of a number. Clients built on other libraries word it differently, but the cause is the same: the pipe to the server closed.

## Causes (most to least likely)

1. **The server crashed on start.** A required environment variable is missing, an argument names a folder that does not exist, the runtime is the wrong version, or a dependency failed to load. The server writes the reason to stderr and exits.
2. **The launcher started, but the server did not.** `npx` or `uvx` ran, then failed to download or resolve the package (a typo in the name, a version that does not exist, no network, a private registry without credentials) and exited with an error. If the launcher itself is missing, you get a different message: see [spawn npx ENOENT](/learn/troubleshooting/spawn-npx-enoent).
3. **The server wrote something other than JSON-RPC to stdout.** The specification says the server "MUST NOT write anything to its `stdout` that is not a valid MCP message". A `print` or `console.log` at startup, a banner, or a progress bar breaks that rule. How a client reacts varies: the official TypeScript SDK reports the bad line as an error and skips it, while other clients may give up on the connection. A log line written without a trailing newline is worse, because it merges with the next real message and both are lost.
4. **The server quit on a request it did not understand.** Under the 2026-07-28 revision, a client may probe a server with `server/discover` before anything else. The stdio binding notes that older servers answer unknown requests with "implementation-defined errors ... or not at all", and some simply exit.
5. **The process was killed.** The client stopped it after a timeout or at shutdown, the operating system killed it for memory, or a container runtime stopped it at a limit.
6. **Windows command shims.** On Windows, `npx` and `npm` are `.cmd` files, which Node.js cannot start without a shell. A client that spawns `npx` directly fails before the server runs, and depending on the client you see `spawn npx ENOENT` or a closed connection. [spawn npx ENOENT](/learn/troubleshooting/spawn-npx-enoent) covers this case in full.

## How to check

Run the exact command the client runs, from a terminal, with the same arguments and environment:

```bash
npx -y @modelcontextprotocol/server-filesystem /tmp/project
```

A healthy stdio server prints at most a line or two on stderr and then waits silently for input. If it exits instead, the last lines it printed are the cause. Check the exit status with `echo $?` after it returns.

Next, send it one `initialize` request and look at what comes back on stdout only. This uses the dependency-free echo server from the L2M repository, `samples/mcp-echo-server/server.mjs`, but works with any stdio server:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  | node samples/mcp-echo-server/server.mjs 2>/dev/null
```

```text
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"l2m-echo","version":"1.0.0"}}}
```

To find stray output, pipe stdout through a line checker. Every line should parse as JSON. Replace `node server.mjs` with your server's command:

```bash
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}'
printf '%s\n' "$INIT" | node server.mjs 2>/dev/null \
  | node -e 'require("readline").createInterface({input:process.stdin}).on("line",l=>{try{JSON.parse(l);console.log("ok  ",l.slice(0,60))}catch{console.log("BAD ",l.slice(0,60))}})'
```

```text
BAD  Server starting on stdio...
ok   {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06
```

A `BAD` line is a log written to the wrong stream.

Finally, read the server's stderr where your client keeps it, such as an MCP log file or an output panel. Clients may capture, forward or ignore stderr, and the specification says they "SHOULD NOT assume `stderr` output indicates error conditions", so a warning there is not always the cause.

## Fix

- **Crash on start:** fix what stderr names. For a missing token, set it in the server's `env` block (see [MCP server can't see API keys](/learn/troubleshooting/mcp-env-vars-not-passed)). For a bad path, use an absolute path that exists on the machine that runs the server.
- **Package not resolved:** pin the exact package and version (`@modelcontextprotocol/server-filesystem@<version>`), run it once by hand so the package is cached, and check registry access from the machine that runs the server.
- **Stdout pollution:** send every log to stderr. In Node.js use `console.error`, in Python `print(..., file=sys.stderr)` or a logging handler on `sys.stderr`. Turn off banners and progress output in the libraries the server loads. If you do not own the server, report it upstream: it breaks the stdio contract.
- **Exit on unknown requests:** upgrade the server, or set the client to speak the older protocol to it so it is opened with `initialize` and no probe.
- **Killed processes:** raise the client's timeout for slow servers, and give containers enough memory.
- **Windows:** set the command to `cmd` with the arguments `/c`, `npx` and the rest, or give the absolute path of `node.exe` and the server's script.

## If you run agents in L2M

L2M's `stdio_mcp` adapter does not print `-32000`. It reports what happened to the process in its own words, and shows the error on the MCP server's page (the server goes **Down** after a failed probe) and in the run trace of the agent or MCP Tool node:

- When the process exits, pending requests fail with `MCP stdio process exited unexpectedly. Last stderr: ...`, followed by the last five lines the server wrote, joined with ` | `. For a server that needs a token, that can read `MCP stdio process exited unexpectedly. Last stderr: Error: GITHUB_TOKEN is not set`.
- A line on stdout that is not JSON is not fatal. L2M ignores it and keeps it with the stderr lines, prefixed `[stdout-non-json]`, so it appears in that message if the server later dies: `Last stderr: [stdout-non-json] Loading config from ./config.json | Error: ENOENT: no such file or directory, open './config.json'`.
- On Linux and macOS, a command that cannot be found gives `MCP stdio process could not start: '<command>' was not found.` with a hint, and never reaches the server.
- A server that stays alive but never answers fails with `MCP stdio request '<method>' timed out after <n>ms.` The default is 120000 ms per request, set by `timeoutMs` in the connection.
- On Windows, L2M runs bare names such as `npx` through `cmd.exe` itself, so no `cmd /c` wrapper is needed. A bare name that `cmd.exe` cannot find therefore shows up as the process exiting, with cmd's "is not recognized" line in `Last stderr`.

After a crash, the next call starts a fresh process. A tool call that was in flight when the process died is sent again only when that is safe, as described in [the safe re-send rule](/product/mcp-2026-07-28#the-safe-re-send-rule); otherwise it fails with the kind `outcome_unknown`. By default L2M opens servers with `initialize`, so older servers are not probed with `server/discover` unless you set their protocol to Auto or Modern. Optionally, the [container sandbox](/product/mcp-server-registry#sandboxed-stdio-servers) runs a server in a throwaway container. The **Playground** under MCP shows the command, the environment variable names and the JSON-RPC exchange of one tool call, which is the quickest way to reproduce a failure.

Related errors: [spawn npx ENOENT](/learn/troubleshooting/spawn-npx-enoent), [Request timed out](/learn/troubleshooting/mcp-request-timed-out) and [MCP server connected but no tools show up](/learn/troubleshooting/mcp-server-shows-no-tools). For how stdio works end to end, read [MCP transports](/learn/mcp/transports).

## Further reading

- [MCP specification, 2026-07-28: stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Overview, error codes](https://modelcontextprotocol.io/specification/2026-07-28/basic) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (modelcontextprotocol.io)
- [JSON-RPC 2.0 specification, section 5.1: Error object](https://www.jsonrpc.org/specification#error_object) (jsonrpc.org)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (github.com)
- [Node.js: Spawning .bat and .cmd files on Windows](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows) (nodejs.org)
- In L2M: [MCP server registry](/product/mcp-server-registry), [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers), [MCP onboarding: Playground](/product/mcp-onboarding#playground), [MCP 2026-07-28 support](/product/mcp-2026-07-28#protocol-modes)
