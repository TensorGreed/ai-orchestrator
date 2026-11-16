---
title: "MCP resource: data an MCP server shares"
term: "MCP resource"
topic: mcp
definition: "Data an MCP server shares by URI, such as a file or a record, for the application to read. Unlike a tool, it is usually the application, not the model, that decides when to read it."
description: "MCP resources are data a server exposes by URI for the app to read, unlike tools, which the model calls. Templates, subscriptions and what L2M reads."
related: [mcp-tool, mcp-prompt, mcp-server, model-context-protocol, mcp-host]
guide: [/learn/mcp/tools-resources-prompts]
---

# MCP resource

**Data an MCP server shares by URI, such as a file or a record, for the application to read. Unlike a tool, it is usually the application, not the model, that decides when to read it.**

The specification calls resources "application-driven". A server lists them with `resources/list`; each has a `uri` and a `name`, and optional fields include `title`, `description`, `mimeType`, `size` and annotations (`audience`, `priority`, `lastModified`). The client reads one with `resources/read` and gets back text, or binary data as base64 in `blob`. A **resource template** such as `file:///{path}` (an RFC 6570 URI template, listed with `resources/templates/list`) describes a whole family of resources without listing each one.

URIs can use `file://`, `git://`, `https://` or a custom scheme. The spec asks servers to use `https://` only when the client could fetch the resource from the web itself.

## Example

```json
{ "jsonrpc": "2.0", "id": 2, "method": "resources/read",
  "params": { "uri": "file:///project/README.md" } }
```

The result's `contents` array carries `{ "uri": ..., "mimeType": "text/markdown", "text": "..." }`. A missing resource is an error: `-32002` in 2025-11-25, and `-32602` from 2026-07-28 on (clients should accept both).

## Subscriptions

A server can offer two kinds of change notice in its `resources` capability. `listChanged` means it sends `notifications/resources/list_changed` when the set of resources changes. `subscribe` means a client can watch single resources. In 2025-11-25 the client sends `resources/subscribe` with a URI; when that resource changes, the server sends `notifications/resources/updated` with only the URI, and the client calls `resources/read` again to get the new content. `resources/unsubscribe` stops it.

The 2026-07-28 revision removes `resources/subscribe` and `resources/unsubscribe`. A client opens one long-lived `subscriptions/listen` stream instead and lists the URIs it wants under `resourceSubscriptions`; updates arrive on that stream tagged with a subscription id.

## Common confusion

A resource is not a tool that reads data. If the model should choose what to look up, with parameters, the server should offer a <Term id="mcp-tool">tool</Term>. If the application should control which context the model gets, and the data has a stable address, a resource fits. A tool result can also point to a resource with a `resource_link`, or embed one.

## In L2M

L2M lists each registered server's resources and templates in its catalog, and re-probes the server when it sends `list_changed` during a run. A workflow reads a resource with an MCP Tool node set to **Read a resource**; the model gets no resource-reading tool of its own. Reads are capped by `MCP_RESOURCE_MAX_BYTES` (5 MiB by default), and optional tool policy rules of kind `resource` can deny URIs ([resources and prompts](/product/mcp-server-registry#resources-and-prompts)). L2M records whether a server supports subscriptions but never subscribes. The [MCP gateway](/product/mcp-gateway) serves tools only, not resources.

## Further reading

- [MCP specification 2025-11-25: resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) (modelcontextprotocol.io)
- [MCP specification 2026-07-28: resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) (modelcontextprotocol.io)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
