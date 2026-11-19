---
title: "Your integrations: MCP tools and APIs as palette nodes"
description: "Add an API from its OpenAPI 3 spec and use registered MCP server tools as ready-made nodes in the L2M palette, each with a form generated from its schema."
---

<div v-pre>

# Your integrations

The palette's **Your integrations** section lists two kinds of ready-made nodes:

- **MCP server tools.** Every tool of every MCP server registered on the **MCP servers** page, as
  `<server> · <tool>`. Tools the tool policy blocks for you are left out.
- **API operations.** Every operation of every API added to the project from its OpenAPI 3 spec, as
  `<API> · <operation>`.

Nothing here is a new kind of node. A tool adds an **MCP Tool** node bound to that server and tool; an operation
adds an **HTTP Request** node with the operation's method and URL. They run, retry, log and replay like any other
MCP Tool or HTTP Request node, and a workflow that uses them exports and imports as usual.

Builders and admins see the section. Palette search ranks these entries with the built-in nodes, so typing
`create ticket` finds `Ticket Desk · Create a ticket`.

## Tools of a registered MCP server

1. An admin registers the server on the **MCP servers** page. Its tools are listed when the server is probed.
2. Open the palette: the server's tools show under **Your integrations**.
3. Pick one. The MCP Tool node's **Arguments** form is generated from the tool's input schema: text, numbers,
   true/false, choices, lists and nested objects get their own fields; anything the form cannot show becomes a
   JSON field.

Any value may be an expression, such as `{{ webhook.ticket_id }}`. A number or true/false field takes an
expression as is, so it renders as the value, not as text. The form writes the node's `argsTemplate`, which is
what runs.

**Edit as JSON** switches the node back to the plain **Tool Args Template** field. A node that writes JSON, such as
one saved before this form existed, shows **Use a form** when its tool has a schema; it replaces the JSON (after
asking).

**Refreshing the tools.** The palette reads the tools from the server's last probe. Probes run on the server's
schedule; an admin can also refresh one from **Add an API…** (or the MCP servers page).

## Add an API from its OpenAPI spec

1. Open the palette and click **Add an API…**.
2. Paste the spec's URL, or choose a JSON or YAML file. Optionally give it a name and a base URL.
3. Click **Add API**. Each operation now shows under **Your integrations**.

Then pick an operation. The HTTP Request node shows the operation (method, path and summary) and a form with its
**Path**, **Query** and **Headers** parameters and its **Body**. The form writes the node's URL, headers and body
templates; **Request** under the form shows what will be sent. **Edit the request directly** turns the node into a
plain HTTP Request node with the same request.

Credentials never live in the spec. Pick a **Secret** on the node. It is sent the way the spec's security scheme
says:

| The spec's scheme | How the secret is sent |
|---|---|
| HTTP bearer, OAuth 2, OpenID Connect | `Authorization: Bearer <secret>` |
| HTTP basic | `Authorization: Basic …`; the secret holds `user:password` |
| API key in a header | in that header |
| API key in the query | as that query parameter (never shown in run logs or error messages) |
| none, or a cookie key | no scheme: a picked secret is sent as a bearer token |

A secret sent in its own header or in the query is never sent to another site: a redirect to another host fails the
node instead.

### What is supported

- OpenAPI 3.0 and 3.1, JSON or YAML, up to 2 MB and 500 operations. Swagger 2.0 is refused.
- `GET`, `POST`, `PUT`, `PATCH` and `DELETE` operations; path, query and header parameters; JSON request bodies
  (other content types get one text field). Cookie parameters are left out.
- Local `$ref`s (`#/components/...`). References to other files are treated as any value.
- The base URL is the spec's first server. A relative server URL is resolved against the spec's URL. When the
  spec names no server, set the base URL in the dialog.

### Reading a spec from a URL

The URL goes through the same outbound checks as HTTP Request nodes (`OUTBOUND_DENY_PRIVATE`,
`OUTBOUND_ALLOWLIST`; cloud metadata and link-local addresses are always refused). Redirects are checked again.
Reading stops after 15 seconds or 2 MB. A URL with a user name or password is refused.

### Refreshing and removing

**Refresh** reads the spec again from its URL (an uploaded spec asks for the new file) and reports the operations
that were removed. A base URL you set stays; one that came from the spec follows it. Nodes already in workflows keep
their request: a node whose operation was removed still runs, and its inspector says the operation is gone.

**Remove** takes the API out of the palette. Nodes made from it keep running.

## Who can do what

| Action | Who |
|---|---|
| See **Your integrations** and add nodes from it | builders and admins with access to the project |
| Add, refresh, rename or remove an API | builders and admins who may edit workflows in the project |
| Register an MCP server, or refresh its tools | admins |

APIs belong to a project: another project's palette does not show them, and they are deleted with their project.
The API calls `GET /api/catalog`, `/api/catalog/openapi-specs` (see [API endpoints](../api/endpoints.md)).

</div>
