# Outbound URL guard

Nodes that fetch a URL the workflow author or upstream data supplies —
**HTTP Request**, **Web Browse**, the **Chart** node's `data.url`, the
**PDF** node in HTML-render mode (including every sub-resource and WebSocket
the page opens), and **RAG** endpoints set on a node (a vector store's
`endpoint`, an embedder's `baseUrl`, the Azure OpenAI embeddings node's
`endpoint`) — run that URL through a shared guard before any request leaves
the host. This
blocks server-side request forgery (SSRF) and local-file reads through those
nodes.

MCP HTTP servers are out of scope here; they have their own connection policy.

## Policy

- **Schemes.** Only `http:` and `https:` can be fetched. `file:`, `data:`,
  `javascript:` and anything else are refused, so one of these nodes can never
  read the local disk or run inline script through a URL.
- **Always blocked.** Cloud metadata endpoints (`169.254.169.254`,
  `fd00:ec2::254`, `metadata.google.internal` and the like) and link-local,
  multicast, unspecified, reserved and documentation ranges. The allowlist
  never overrides these.
- **Private ranges and localhost** are allowed by default. Turn on
  `OUTBOUND_DENY_PRIVATE` to block them, then use `OUTBOUND_ALLOWLIST` to let
  specific internal hosts or networks back through.

The host is resolved and **every** address it resolves to is classified, so a
name that points at a blocked address is refused. Redirects are re-checked hop
by hop, and the browser-based nodes check each sub-resource the page requests,
not just the first document. WebSockets a page opens (`ws:` / `wss:`) get the
same host check; a refused socket is closed before it connects. A refused URL
fails the node at once and is not retried.

**Inline chart images.** A Chart spec may use `data:image/...` URLs for image
marks; they are decoded locally and never fetched. Each one is capped at 2 MB
(encoded). Other `data:` URLs and `file:` loads are refused.

**DNS rebinding.** For HTTP Request, the Chart node and node-configured RAG
endpoints, the connection is pinned. The socket's own DNS lookup goes through the guard: the name is
resolved once at connect time, every address is checked, and the socket can
only connect to an address that passed. A name that answers a public address
to the first check and a metadata or private address a moment later is
refused. The URL keeps its hostname, so TLS SNI, certificate validation and
the `Host` header are unchanged.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OUTBOUND_DENY_PRIVATE` | `false` | Also block private ranges and localhost for the guarded nodes. |
| `OUTBOUND_ALLOWLIST` | empty | Comma-separated hosts or CIDRs allowed through under `OUTBOUND_DENY_PRIVATE`, e.g. `10.0.0.0/8,*.internal,db.corp:5432`. |

## What is not covered

- **Browser-based nodes are not pinned.** Web Browse and the HTML-render PDF
  path check each request and WebSocket at route time, but Chromium then
  resolves the name itself. A short-TTL rebinding name can still pass the check and connect
  elsewhere. Under `OUTBOUND_DENY_PRIVATE` that is a gap for private ranges;
  the metadata block is affected the same way.
- **Python code nodes on the host** open their own sockets and never go
  through this guard. See
  [Code execution](./code-execution.md#python-on-the-host).
- **Other browser channels.** WebRTC, and requests a service worker makes,
  are not routed through the guard.
- **Deployment-level endpoints** are infrastructure settings and are not
  checked: LLM provider base URLs, connector SDK endpoints, and RAG endpoints
  that come from environment variables (`QDRANT_ENDPOINT`, `CHROMA_ENDPOINT`
  and the like) rather than from a node. MCP HTTP servers have their own
  policy.
