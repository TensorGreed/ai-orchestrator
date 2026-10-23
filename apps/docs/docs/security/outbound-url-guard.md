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
name that points at a blocked address is refused (DNS rebinding). Redirects are
re-checked hop by hop, and the browser-based nodes check each sub-resource the
page requests, not just the first document.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OUTBOUND_DENY_PRIVATE` | `false` | Also block private ranges and localhost for the guarded nodes. |
| `OUTBOUND_ALLOWLIST` | empty | Comma-separated hosts or CIDRs allowed through under `OUTBOUND_DENY_PRIVATE`, e.g. `10.0.0.0/8,*.internal,db.corp:5432`. |

## Residual note

The guard resolves and validates the host, then the request is made. A name
that re-resolves to a different address between the check and the socket
connect (a narrow TOCTOU window) is not yet pinned to the checked address;
closing that fully needs a custom connection dispatcher and is tracked
separately.
