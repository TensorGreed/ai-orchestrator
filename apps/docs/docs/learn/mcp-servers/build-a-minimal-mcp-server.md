---
title: "Build a minimal MCP server and test it with an agent"
sidebarTitle: "Build a minimal MCP server"
description: "A 40-line MCP server with one tool, run over stdio and Streamable HTTP, then tested with recorded calls so CI can check it without a model."
level: intermediate
related: [mcp-server, mcp-tool, stdio-transport, streamable-http, cassette, snapshot-mock]
---

# Build a minimal MCP server and test it with an agent

A minimal <Term id="mcp-server">MCP server</Term> is one file: create a server object, register one tool with a name, a description and an input schema, and connect it to a transport. With the official TypeScript SDK v2 that is about 40 lines, and the same tool can be served over <Term id="stdio-transport">stdio</Term> for a local client and <Term id="streamable-http">Streamable HTTP</Term> for a remote one. Once an agent can call it, record its calls and commit its tool schema, so CI checks the server on every change without calling a model.

## What you will build

A server called `word-tools` with one tool, `count_words`. It takes a `text` string and returns the number of words and characters, as text and as structured content. It changes nothing, so it says so with `readOnlyHint`.

The example uses the versions current in November 2026:

| SDK | Package | Version used here |
|---|---|---|
| TypeScript v2 | `@modelcontextprotocol/server` (plus `@modelcontextprotocol/node` for Node's HTTP server) | 2.4.0 (node adapter 2.1.2), with `zod` 4.6.7 |
| Python v2 | `mcp` | 2.3.0, Python 3.10 or later |

The TypeScript SDK split into separate packages in v2. The README calls `@modelcontextprotocol/server` and `@modelcontextprotocol/client` "v2 of the SDK", "the stable release line", and says v1 (`@modelcontextprotocol/sdk`) "continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27)". The v2 serving guides use `serveStdio()` and `createMcpHandler()`, each taking a factory; per the guides, they replace the `new StdioServerTransport()` + `server.connect(transport)` wiring, which v1 code uses and which the v2 README's first example still shows. If a tutorial's imports come from `@modelcontextprotocol/sdk/server/mcp.js`, it is v1.

## The server in TypeScript

```bash
mkdir word-tools && cd word-tools
npm init -y && npm pkg set type=module
npm install @modelcontextprotocol/server@2.4.0 @modelcontextprotocol/node@2.1.2 zod@4.6.7
```

Save this as `server.mjs`:

```js
// server.mjs: one read-only tool, served over stdio or Streamable HTTP.
import { createServer } from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

// A factory: the SDK builds a fresh server per stdio connection or HTTP request.
function buildServer() {
  const server = new McpServer({ name: 'word-tools', version: '1.0.0' });
  server.registerTool(
    'count_words',
    {
      description: 'Count the words and characters in a piece of text.',
      inputSchema: z.object({ text: z.string().max(100_000) }),
      outputSchema: z.object({ words: z.number(), characters: z.number() }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ text }) => {
      const result = { words: text.split(/\s+/).filter(Boolean).length, characters: text.length };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  );
  return server;
}

if (process.argv.includes('--http')) {
  const handler = toNodeHandler(createMcpHandler(buildServer));
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void handler(req, res);
  }).listen(3000, '127.0.0.1', () => console.error('word-tools on http://127.0.0.1:3000/mcp'));
} else {
  serveStdio(buildServer);
  console.error('word-tools on stdio'); // stderr only: stdout carries JSON-RPC
}
```

What each part does:

- **`registerTool`** takes the tool name, a config object and a handler. The SDK turns the zod schemas into the JSON Schema clients see in `tools/list`, and checks arguments against `inputSchema` before your handler runs.
- **`outputSchema` and `structuredContent`** give clients a typed result next to the text. Keep the text copy too: the spec says a tool that returns structured content "SHOULD also return the serialized JSON in a TextContent block" for clients that read only text.
- **`annotations`** are hints for clients. `readOnlyHint: true` says the tool changes nothing; `openWorldHint: false` says it talks to nothing outside. Clients may ignore them, and should, for servers they have not reviewed (see [MCP tool annotations](/learn/mcp/tool-annotations)).
- **The factory** (`buildServer`) is how v2 works on both transports. `serveStdio` calls it for the connection; `createMcpHandler` calls it for every HTTP request, so the HTTP endpoint keeps no state between requests.
- **`console.error`** for logs. On stdio, stdout is the protocol channel and any stray `console.log` line corrupts it.
- **Host and Origin checks.** The SDK's HTTP handler "validates no `Host` header, no `Origin` header, and no token". On a loopback port, the Host check is what stops DNS rebinding, so the two checks sit in front of it.

## Run it over stdio

A stdio server is started by its client. To see it work without a client, pipe three JSON-RPC messages into it:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"count_words","arguments":{"text":"hello MCP world"}}}' \
  | node server.mjs
```

The answer to the call:

```json
{"result":{"content":[{"type":"text","text":"{\"words\":3,\"characters\":15}"}],"structuredContent":{"words":3,"characters":15}},"jsonrpc":"2.0","id":2}
```

Send `"text": 5` instead and the SDK answers with `isError: true` and `Input validation error: ... expected string, received number`. Your handler never runs. The spec counts input validation failures as tool execution errors, reported with `isError: true`, because they carry "actionable feedback that language models can use to self-correct"; an unknown tool name is a JSON-RPC protocol error instead.

## Run it over Streamable HTTP

```bash
node server.mjs --http
```

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"count_words","arguments":{"text":"a b"}}}'
```

The reply comes back as one server-sent event carrying the same result. A request with another `Host` header, for example `-H 'host: evil.example'`, gets `403 Forbidden` before it reaches the handler. The endpoint is stateless: it issues no `Mcp-Session-Id`.

This server has no authentication, so keep it on loopback. To serve it to other machines, put a bearer-token check in front of the handler (the SDK has `requireBearerAuth`) and follow [MCP authorization](/learn/mcp/authorization).

## The same server in Python

```bash
uv init word-tools-py && cd word-tools-py
uv add "mcp[cli]==2.3.0"
```

```python
# server.py
import sys
from mcp.server import MCPServer
from mcp.types import ToolAnnotations

mcp = MCPServer("word-tools")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
def count_words(text: str) -> dict[str, int]:
    """Count the words and characters in a piece of text."""
    return {"words": len(text.split()), "characters": len(text)}


if __name__ == "__main__":
    mcp.run(transport="streamable-http" if "--http" in sys.argv else "stdio")
```

The Python SDK builds the input schema from the type hints, the description from the docstring and an output schema from the return type, and returns the dict as structured content and as text. `uv run server.py` serves stdio; `uv run server.py --http` serves `http://127.0.0.1:8000/mcp`. Unlike the TypeScript factory above, the Python HTTP server keeps sessions by default and sends an `Mcp-Session-Id` header. In v2 the server class is `MCPServer` from `mcp.server`; older examples use the v1 name.

## Register it in L2M

L2M is a self-hosted workflow builder and agent runtime that acts as an MCP client. Register the server once and every workflow can use it.

1. Open **MCP servers → + Register server**.
2. For stdio, pick the `stdio_mcp` adapter and give the command:

   ```json
   { "command": "node", "args": ["/opt/word-tools/server.mjs"], "timeoutMs": 30000 }
   ```

   For HTTP, pick `http_mcp`:

   ```json
   { "endpoint": "http://127.0.0.1:3000/mcp", "transport": "http_streamable", "authType": "none" }
   ```

   If the L2M API runs in a container, `127.0.0.1` is the container itself. Bind the server where the API can reach it, and swap `localhostHostValidation()` for `hostHeaderValidation()` with that host name, since the localhost check refuses any other `Host`.
3. Save. Unless you turn probing off, L2M probes the server right away (in the default legacy mode, `initialize` then `tools/list`) and stores a snapshot of its tools ([MCP server registry](/product/mcp-server-registry#registering-a-server)).
4. Open **MCP → Playground**, pick `count_words` and call it from a form generated from its schema ([playground](/product/mcp-onboarding#playground)).

The server speaks both protocol eras. L2M opens servers with `initialize` by default; set `"protocolMode": "auto"` in the connection to try MCP 2026-07-28 first, which this server also answers ([MCP 2026-07-28 support](/product/mcp-2026-07-28)). Against `server.mjs`, L2M's stdio client in `legacy` mode opens with `initialize`, in `auto` mode agrees on 2026-07-28, and both return `{"words":3,"characters":13}` for `"one two three"`.

To give it to an agent, attach an **MCP Tool** node with this server to an Agent node's `tool` port, or list it in the agent's `mcpServers`. The tool arrives with its annotations, so the [tool policy](/product/mcp-tool-policy#read-only-classification) counts it as read-only. An admin can override that on the server's Tools table, and should for any server nobody has reviewed. Note that the **Ask before write tools** approval trusts only an admin's mark, never the server's hint ([approvals](/product/approvals#approval-before-write-tools)).

If your deployment enforces a catalog (`MCP_CATALOG_ENFORCE=true`), the catalog file needs an approved entry for the command first. A command like `node /opt/word-tools/server.mjs` counts as pinned by its path ([deployment catalog](/product/mcp-onboarding#deployment-catalog)).

## Test it without a model

A tool server is easy to test, because nothing in it needs a model. Three layers, from cheapest to most realistic:

**1. Call the handler.** The TypeScript SDK's own docs drive a handler's `fetch` with a real client in process ([Test a server](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md)). That is a plain unit test for your logic and schemas.

**2. Fail on breaking schema changes.** Export the server's accepted snapshot from L2M once, commit it, and compare the live server with it in CI. The check needs no deployment and no model. `pnpm l2m` runs from an L2M checkout, so give the server's absolute path:

```bash
pnpm l2m mcp snapshot export --server mcp_123 --out word-tools.snapshot.json                    # once
pnpm l2m mcp check --snapshot word-tools.snapshot.json --stdio "node /opt/word-tools/server.mjs" # in CI
```

The check exits 1 when a change would break callers: a tool removed; an input property removed, its type narrowed or changed, a property newly required, or an input enum value removed; the output schema or an output property removed, a required output property made optional, an output type widened or changed, or an output enum given a new value. Adding tools or optional input properties is listed but passes.

**3. Replay recorded calls.** Turn on **Record MCP calls** in the editor's **⋯** menu and run a workflow that uses the tool. A direct MCP Tool node with `"argsTemplate": "{\"text\":\"one two three\"}"` calls the server with no model in the loop. L2M saves every request and result in a <Term id="cassette">cassette</Term>, with secrets replaced by `[REDACTED]`. Download it, then serve it as a <Term id="snapshot-mock">snapshot mock</Term>:

```bash
pnpm l2m mcp mock --snapshot word-tools.snapshot.json --cassette run.cassette.json
```

The mock is a stdio MCP server. It checks arguments against the snapshot's schema and answers from the cassette, so tests of the workflows that use `word-tools` run without the real server. **Replay** on the Runs page does the same inside L2M; in `strict` mode it never contacts the server.

The full CI setup (exit codes, JSON output, API keys) is in [Test MCP servers in CI](/guides/test-mcp-servers-in-ci). For what each technique catches and misses, see [testing agents that call MCP tools](/learn/testing/testing-mcp-tools).

## Compare with the sample echo server

The repository ships `samples/mcp-echo-server/server.mjs`, a stdio server written with no SDK at all: newline-delimited JSON-RPC by hand, about 130 lines. It has three tools (`echo` read-only, `create_ticket` a write tool with nested arguments, `credentials` which reports which of two env vars are set, never their values). Read it to see what the SDK does for you: the sample writes its `initialize` reply and error objects by hand and never checks arguments against its input schemas, while the SDK does all three. The sample catalog registers it as `node samples/mcp-echo-server/server.mjs`.

## Try it in L2M

The quickstart workflow wires an agent to two MCP Tool nodes on the built-in mock server. Its chat model is the echo provider, which never asks for a tool, so the demo shows the wiring only. In your own L2M, point one of those nodes at the registered `word-tools` server and attach a chat model that supports tool calling to see `count_words` in an agent run.

<TryInDemo workflow="wf-mcp-agent-quickstart" />

## Further reading

- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) README, and its guides [Serve over stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md) and [Serve over HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [Python SDK](https://github.com/modelcontextprotocol/python-sdk) README
- [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (MCP specification)
- [MCP transports](/learn/mcp/transports): stdio vs Streamable HTTP
- [MCP tools, resources and prompts](/learn/mcp/tools-resources-prompts)
- [Testing MCP workflows](/product/testing-mcp-workflows): cassettes and snapshot mocks
- [Test the client side with the time and everything servers](/learn/mcp-servers/time-and-everything-servers)
