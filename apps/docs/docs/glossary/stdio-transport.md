---
title: "stdio transport: running an MCP server locally"
term: "stdio transport"
topic: mcp
definition: "The MCP transport in which the client starts the server as a child process and exchanges newline-delimited JSON-RPC messages over the process's standard input and output."
description: "With the stdio transport the client starts the MCP server as a child process and talks over stdin and stdout. Why it is simple and how to sandbox it."
related: [streamable-http, mcp-server, mcp-client]
guide: [/learn/mcp/transports]
---

# stdio transport

**The MCP transport in which the client starts the server as a child process and exchanges newline-delimited JSON-RPC messages over the process's standard input and output.**

Local MCP servers usually use stdio. A config entry names a command, such as `npx -y some-server@1.2.0 /srv/shared`, and the client runs it. The client writes requests to the server's stdin; the server writes replies to stdout, one JSON message per line. The spec keeps stdout clean: the server must write nothing there that is not a valid MCP message, and logs go to stderr. To shut down, the client closes stdin, then sends `SIGTERM` and finally `SIGKILL` if the process will not exit.

Why it is popular: no port, no TLS, no tokens. Only the process that started the server can talk to it. The spec says clients "SHOULD support stdio whenever possible", and the authorization spec says stdio servers should not use the OAuth flow but take credentials from the environment instead.

The cost is trust. A stdio server is a program on your machine with your rights. The MCP security best practices list malicious start-up commands and malicious packages as attacks, and tell clients to show the exact command before running it and to sandbox the process with minimal access to files and network.

## Example

```json
{ "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "/srv/shared"],
  "env": { "LOG_LEVEL": "info" } }
```

Pinning the version matters: `npx -y some-server` without one runs whatever the package registry serves today.

## Common confusion

"Local" does not mean "safe". stdio removes the network attack surface, but the server can still read your SSH keys if nothing stops it. It also does not mean "on my laptop": a platform can start stdio servers on a shared host, where the same risks apply to every user.

## In L2M

The `stdio_mcp` adapter starts the server's command on the API host, with its secret passed as an environment variable. Optionally, an admin runs it in a [container sandbox](/product/mcp-server-registry#sandboxed-stdio-servers) (no network by default, read-only file system, non-root user), and a [deployment catalog](/product/mcp-onboarding#deployment-catalog) can limit stdio servers to pinned, approved packages.

## Further reading

- [MCP specification 2025-11-25: transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (modelcontextprotocol.io)
- [MCP security best practices: local MCP server compromise](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) (modelcontextprotocol.io)
