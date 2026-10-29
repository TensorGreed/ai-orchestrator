---
description: "The L2M MCP control plane: one place for every MCP server your agents call, with fleet health, a tool catalogue, policies, toolsets, the gateway and change history."
---

# MCP control plane

The **MCP** section of the sidebar gathers everything about the MCP servers your agents call: their health, their tools, the rules that govern them, the gateway that re-exposes them and what changed. Builders and admins see the section; operators and viewers do not. Builders can read every page; actions that change the registry, policy, toolsets or clients stay admin-only inside the pages.

| Page | What it is for |
| --- | --- |
| **Overview** | Fleet health at a glance and what needs a decision. |
| **Servers** | The [server registry](./mcp-server-registry.md): register, probe, review schema changes, OAuth and sampling settings. |
| **Tools** | One catalogue of every tool on every registered server. |
| **Policies** | [Tool policy](./mcp-tool-policy.md) rules and the "Test a tool" form. |
| **Toolsets** | Groups of tools served by L2M's own [MCP gateway](./mcp-gateway.md). |
| **Clients** | Gateway client tokens and their usage. |
| **Playground** | Call a tool, read resources and preview prompts ([onboarding](./mcp-onboarding.md)). |
| **Changes** | A chronological feed of what changed across the fleet. |

Every page is also in the command palette (⌘K / Ctrl+K, "Go to MCP · …"). With the sidebar collapsed, each icon has a tooltip naming the page; at phone widths the section is part of the navigation drawer.

## Overview

The overview reads `GET /api/mcp/overview` once per visit (and on **Refresh**), for a telemetry window of 24 hours, 7 days or 30 days.

- **Totals**: servers, tool calls, failed calls and active gateway clients for the window.
- **Server health**: one bar split by status (down, degraded, healthy, not probed). Every segment has a tooltip with its count, and the legend repeats each status with its label; status colour is never the only cue. **Show table** lists every server with its status, last probe and p95 latency. Servers that are not healthy are listed underneath with a link to their page.
- **Needs attention**: breaking schema changes waiting for review (and whether they block runs), servers whose circuit breaker is open or half-open (with the next trial time), sandboxed stdio servers whose last check says the container cannot start, OAuth connections that are not connected, expired or failing, and open elicitation questions from MCP servers waiting for an answer. OAuth error details and a breaker's last failure are shown to admins only. Servers that use each user's own account are not listed for OAuth; each person sees their own connection under **My connections**.
- **Sampling enabled**: the servers allowed to request model completions, with their token and request limits.
- **Busiest tools** and **Most error-prone tools**: ranked bars with a per-row tooltip and a table view; a row opens the tool in the catalogue.
- **Active gateway clients** and **Latest changes**, each with a link to the full page.

## Tools catalogue

**MCP → Tools** lists every tool from the current snapshot of every registered server (`GET /api/mcp/tools`). Search matches the tool name, title, description and server. Filters narrow by server, server status, read-only or write, destructive, open world, **blocked for my role** and **has output schema**. Calls, errors, p95 latency and cost come from the tool telemetry for the chosen window, and every column sorts; tools without calls or without a price sort last.

The **Policy** column shows what the policy means for you in the active project: blocked, destructive, write or read-only.

Selecting a tool opens a drawer with:

- its annotations as chips, its read-only classification and where that came from;
- the input schema and the output schema, when the server declares one;
- a **policy decision** for any role and project, evaluated by `POST /api/mcp/policies/evaluate`, with a link to the deciding rule;
- the recent calls in the window (result, duration and where the call came from);
- the workflows and nodes that use the tool, each opening the workflow in the editor.

Escape or the close button returns focus to the tool you opened.

## Changes feed

**MCP → Changes** reads `GET /api/mcp/changes` and shows the newest changes first, grouped by day:

| Kind | Source |
| --- | --- |
| Schema | Tool schema snapshots and their diffs; breaking ones are marked **Breaking** and open their diff while waiting for review. |
| Acceptance | An admin accepted a breaking change. |
| Status | Transitions such as Healthy → Down, replayed from the probe history. |
| Policy, Classification | Rule edits and read-only overrides. |
| Toolset, Client | Toolset edits and members, client tokens created or revoked. |
| OAuth | Connections made, removed, or failing to refresh, including users connecting, disconnecting or being revoked from servers that use each user's own account. |
| Sampling | Changes to a server's sampling settings. |
| Circuit breaker | A breaker opened (marked **Breaking**), went half-open, closed, or was reset by an admin. |
| Server | Registrations, imports, removals and other settings changes. |
| Resources & prompts | What a server lists as of its last probe (informational). |

Filter by server, by one or more kinds, or show breaking changes only. Each entry links to the page that owns it: the server, the policy rule, the tool, the toolsets or the clients. Who made a change is shown to admins only; builders see what changed. Status transitions are derived from the last 200 probes per server and audit-based entries from the audit log, so they follow its retention.

## Canvas markers

On the editor canvas, MCP Tool nodes that use a registered server, including tools attached to an agent as satellites, show:

- the server's **probe status** as a dot (with the status written out on cards); its tooltip and accessible name read "MCP server *name*: *status*";
- **Breaking change** when the server has a schema change waiting for review;
- **Circuit open** or **Half-open** when the server's circuit breaker is pausing calls; it opens the server;
- your **policy state** for the tools the node uses: **Blocked**, **Destructive** or **Write** (read-only tools show nothing extra). A node that offers every tool of a server shows the worst state among the tools you may still use, plus how many are blocked.

Clicking the status dot or the breaking-change marker opens the server; clicking **Blocked** opens the rule that blocks the tool. The editor makes one request per workflow for the servers its nodes reference (`GET /api/mcp/tools?detail=false&serverIds=…`), caches it, and refreshes it when the browser window regains focus. Markers need builder access; for operators and viewers the canvas shows none.

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/mcp/overview?window=` | builder | Fleet health, attention items, ranked tools, clients and the latest changes. |
| GET | `/api/mcp/tools?projectId=&window=&serverIds=&detail=` | builder | Tool catalogue with annotations, classification, your access, telemetry, recent calls and usages. `detail=false` returns only status, breaker state and access. |
| GET | `/api/mcp/changes?serverId=&kind=&limit=` | builder | Changes feed, newest first; `kind` takes a comma-separated list. Actors and raw audit metadata are included for admins only. |

All three only read existing tables (`mcp_servers`, probes, snapshots, catalogs, telemetry, policies, clients, elicitations and the audit log); nothing leaves your deployment.
