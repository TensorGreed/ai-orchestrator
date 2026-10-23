# Outbound URL guard

Nodes that fetch a URL the workflow author or upstream data supplies —
**HTTP Request**, **Web Browse**, the **Chart** node's `data.url`, and the
**PDF** node in HTML-render mode (including every sub-resource the page loads) —
run that URL through a shared guard before any request leaves the host. This
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
not just the first document.

**DNS rebinding.** For HTTP Request and the Chart node, the connection is
pinned. The socket's own DNS lookup goes through the guard: the name is
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
  path check each request at route time, but Chromium then resolves the name
  itself. A short-TTL rebinding name can still pass the check and connect
  elsewhere. Under `OUTBOUND_DENY_PRIVATE` that is a gap for private ranges;
  the metadata block is affected the same way.
- **Python code nodes on the host** open their own sockets and never go
  through this guard. See
  [Code execution](./code-execution.md#python-on-the-host).
- **Provider and connector endpoints** that an admin configures (LLM base
  URLs, connector SDK endpoints) are infrastructure settings and are not
  checked. MCP HTTP servers have their own policy.
