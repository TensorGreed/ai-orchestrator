---
description: "MCP tool policy in L2M: allow and deny rules by project, role, server and tool, read-only versus write classification, and a per-workflow no-write-tools switch."
---

# MCP tool policy

Tool policy decides which MCP tools agents and MCP Tool nodes may use. It has three parts:

- **Rules.** Admins write allow and deny rules scoped by project, role, server and tool name.
- **Read-only classification.** Every tool is either read-only or a write tool, taken from an admin override or from the server's own annotations.
- **No write tools.** A per-workflow switch that blocks every write tool in that workflow.

Nothing changes on an existing install until an admin adds a rule: a tool that no rule matches is allowed.

Policy is enforced in the runtime, not only in the UI. Blocked tools are removed from an agent's tool set before the model sees it, and every call is checked again when it is made.

## Rules

Rules live under **MCP → Policies** in the sidebar.

| Field | Meaning |
|---|---|
| Effect | `allow` or `deny`. |
| Applies to | What the rule governs: `tool` (the default), `resource`, `prompt` or `sampling`. See [Rule kinds](#rule-kinds). |
| Project | One project, or all projects. |
| Roles | Any subset of `admin`, `builder`, `operator`, `viewer`. Empty means every role. |
| Server | A registry server id, or an adapter id (`mock-mcp`, `http_mcp`, `stdio_mcp`, ...) for servers configured inline on a node. Empty means any server. |
| Pattern | An exact name, or a glob where `*` matches any run of characters (including none). Other characters, such as `.`, are matched literally. Defaults to `*`. For tools it is the tool name; for the other kinds see [Rule kinds](#rule-kinds). |
| Annotation condition | Optional. Only tools whose annotation hints meet the condition match, for example **destructive** tools. See [Annotation conditions](#annotation-conditions). |
| Name, description | Optional. The name is what traces and error messages show. |
| Enabled | Disabled rules are ignored. |

An adapter id never matches a registered server. A rule on `http_mcp` reaches HTTP servers configured inline on nodes, not every registered HTTP server. To target a registered server, pick it by its registry id.

### Rule kinds

A rule applies to one kind of request. Rules of another kind are ignored, so a deny on tools never hides a resource and a resource rule never hides a tool.

| Kind | Pattern matches | Where it is enforced |
|---|---|---|
| `tool` | The tool name. Annotation conditions apply. | Tool discovery and every call: agents, MCP Tool nodes, the playground and the gateway. |
| `resource` | The resource URI, for example `gh://repo/*` or `*.pdf`. | Resource lists (blocked entries are marked), reads from the playground and from MCP Tool nodes in read mode. |
| `prompt` | The prompt name. | Prompt lists, previews in the playground and server prompts bound to agent, LLM and chat model nodes. |
| `sampling` | The model name the server's request resolves to. | A server's `sampling/createMessage` request, after the server's own sampling settings allowed it. |

The same evaluation order applies within a kind: no rule means allowed, deny wins, and an allow strictly inside a deny carves an exception.

### Evaluation order

For one tool call:

1. Collect the enabled rules whose scope matches the call. Project, role, server, tool pattern and annotation condition must all match.
2. If no rule matches, the tool is **allowed**. This is the default.
3. If no matching rule is a deny rule, the tool is **allowed**.
4. A matching deny rule is set aside when a matching allow rule is **strictly narrower** than it. That is how an allow rule carves an exception out of a broader deny.
5. If any matching deny rule is left, the tool is **denied**. The first such rule is reported, with rules taken oldest first.

Deny wins every tie. An allow rule only beats a deny rule it sits inside.

An allow rule is **strictly narrower** than a deny rule when it is inside the deny in every field and smaller in at least one:

- **Project:** a specific project is inside "all projects", and inside the same project.
- **Roles:** a subset is inside a larger set. Any set is inside "every role", but "every role" is not inside a specific set.
- **Server:** a specific server is inside "any server", and inside the same server.
- **Tool pattern:** containment is checked conservatively. Anything is inside `*`, and an exact name is inside a glob that matches it. Two different globs are never treated as nested.
- **Annotation condition:** a rule with a condition is inside a rule without one, and inside a rule with the same condition. Two different conditions are never treated as nested.

### Examples

**Viewers get one GitHub tool.** Rules: deny server `GitHub` for `viewer`, and allow tool `search_issues` on server `GitHub` for `viewer`. The allow is inside the deny and narrower in the tool, so viewers can call `search_issues` and nothing else on GitHub. Other roles are untouched.

**A broad allow does not override a narrow deny.** Rules: deny server `GitHub` for `viewer`, and allow tool `search_issues` on server `GitHub` for every role. The allow covers every role, so it is not inside the viewer-only deny. Viewers stay blocked from `search_issues`.

**No deletes in one project.** Rule: deny tool `delete_*` in project `Finance`. Every role loses `delete_issue`, `delete_file` and similar tools in that project only.

**No destructive tools for operators.** Rule: deny for `operator` with annotation condition **destructive**. Operators lose every tool that is not read-only and does not declare `destructiveHint: false`, on every server. Add an allow rule for `operator` on one tool name with the same condition to make an exception.

**Inline stdio servers off.** Rule: deny server `stdio_mcp`. Every stdio server configured inline on a node is blocked. Registered stdio servers are not affected, because an adapter id never matches a registry entry.

## Whose role counts

A run is evaluated with one role, its **subject**.

| Run | Role used |
|---|---|
| Manual runs from the editor, "Run this node", retries | The signed-in user who started it |
| Approval decisions | The approver, except that a run resumed after approval keeps the subject it paused with |
| `POST /api/webhooks/execute` and `/api/webhooks/execute/stream`, the manual trigger route | The authenticated user (session or API key) |
| Eval runs | The user who started the eval |
| Public webhooks (`/webhook/:path`, `/webhook-test/:path`), Slack, GitHub, Stripe, Telegram and Discord webhooks, form and public chat triggers, the MCP server trigger | The workflow's creator |
| Schedules, the trigger service, queue workers, error workflows | The workflow's creator |
| Sub-workflows | The parent run's subject, with the sub-workflow's own project and its own "No write tools" setting |

The `triggeredBy` value in a queue request body is a label only; it never chooses the role.

### The workflow creator

Workflows record their creator's user id in `workflows.created_by`. It is set when a workflow is created (including a `PUT` that creates it), imported, imported from another builder, duplicated, made from a template, imported from a share link, or re-created by a version restore. Later saves never change it.

When the column is added to an existing database, each workflow takes the author of its earliest recorded version, when there is one. Workflows without version history stay without a creator.

If the creator is unknown, or the user no longer exists, the run is evaluated as **viewer**, the lowest role. The trace says which case applied.

## Read-only classification

Each tool is read-only or a write tool, decided in this order:

1. **Manual override.** An admin marked the tool read-only or write on the server's Tools table. The override wins in both directions. Only registered servers can be overridden.
2. **Annotation.** The server sent `readOnlyHint` for the tool in `tools/list`. `true` makes it read-only, `false` a write tool.
3. **Unknown.** Anything else is treated as a **write** tool.

The HTTP and stdio adapters keep the annotations a server sends: `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Annotations are hints from the server, not guarantees, which is why the admin override exists. Servers configured inline on a node have no registry entry, so their tools are read-only only through annotations.

The built-in `mock-mcp` server marks `get_current_time` and `lookup_kb` read-only and leaves `calculator` unannotated, so `calculator` counts as a write tool. That makes it handy for trying the switch below.

## Annotation conditions

A rule can carry an **annotation condition** (`annotationHint` in the API). The rule then matches only tools whose hints meet it, on top of its other fields.

| Condition | Matches tools that are |
|---|---|
| `destructive` / `not_destructive` | destructive / not destructive |
| `read_only` / `not_read_only` | read-only / not read-only |
| `idempotent` / `not_idempotent` | idempotent / not idempotent |
| `open_world` / `not_open_world` | open-world / closed-world |

The hints are the MCP tool annotations from `tools/list`, read as the MCP specification says when a hint is missing: `readOnlyHint` defaults to `false`, `destructiveHint` to `true`, `idempotentHint` to `false` and `openWorldHint` to `true`. So a tool with no annotations counts as destructive and open-world, which is the safe reading for deny rules. Two more adjustments:

- An admin's **Mark read-only** or **Mark write** override replaces `readOnlyHint`.
- A read-only tool is never destructive, whatever `destructiveHint` says.

For registered servers the hints come from the server's current snapshot. Agents see them when they discover tools. A direct MCP Tool node lists the server's tools before the call when any enabled rule has a condition; if the hints cannot be read, the defaults above apply. A blocked call's message names the condition, for example `... is blocked by policy 'No destructive tools for operators' (mtp_…) for role operator (rule applies to destructive tools).`

## No write tools

Each workflow has a **No write tools** setting (`settings.noWriteTools` in the workflow JSON). Turn it on from the editor's **⋯** (More actions) menu. While it is on, every write tool is blocked for agents and direct MCP Tool nodes in that workflow.

The switch is checked after the rules. A tool denied by a rule is reported as a policy block, not a write-tool block.

A direct MCP Tool node does not list tools before calling one. When the switch is on and the tool has no manual override, the engine reads the tool's annotations with `tools/list` first. If they cannot be read, the tool counts as a write tool.

## How it is enforced

- **Discovery filter.** When an agent or supervisor node starts, denied tools are removed before the model sees the tool set. This covers tools from the agent's `mcpServers` list, MCP Tool nodes attached to its `tool` port, and the tools of every worker it delegates to. Each worker resolves its own tools under the same subject.
- **Call-time check.** Every call is checked again. A model that asks for a hidden tool by name gets a tool error such as `MCP tool 'calculator' on server 'mcp_…' is blocked by policy 'Viewers: no calculator' (mtp_…) for role viewer.` The call counts as a failed call in [MCP tool telemetry](./mcp-server-registry.md#tool-telemetry).
- **Direct MCP Tool nodes.** A blocked tool fails the node with the same message, naming the rule. The node is not retried, because retrying cannot change a policy decision.
- **Discovery in the editor.** `POST /api/mcp/discover-tools` and `GET /api/mcp/servers/:id/tools` mark tools the current user's role cannot use in the project. They do not hide them, so builders can see why an agent will not get a tool.

Rules and overrides are read when each agent or MCP Tool node starts, so a change applies to the next node that runs.

## Reading the trace

Agent and supervisor node outputs carry a `_toolPolicy` object whenever a policy could apply:

```json
{
  "subject": { "role": "viewer", "source": "fallback", "fallbackReason": "the workflow has no recorded owner" },
  "projectId": "default",
  "noWriteTools": true,
  "hidden": [
    { "tool": "calculator", "server": "mock-mcp", "registryServerId": "mcp_…", "reason": "policy", "ruleId": "mtp_…", "ruleName": "Viewers: no calculator" }
  ]
}
```

`subject.source` is `user` (the signed-in user who started the run), `owner` (the workflow creator) or `fallback` (no usable user, evaluated as viewer). `reason` is `policy` or `no_write_tools`.

The node inspector's **Trace** tab shows this as a **Tool policy** block:

- `Evaluated as builder — triggered by alice@example.com`
- `Evaluated as builder — workflow owner bob@example.com`
- `Evaluated as viewer — workflow owner unknown` (or `workflow owner no longer exists`)

followed by one line per hidden tool:

- `calculator hidden by policy Viewers: no calculator`
- `calculator hidden: write tool and this workflow allows no write tools`

Traces never contain secret values.

## In the Studio

- **MCP servers page, Policies view.** Lists the rules in evaluation order. Admins add, edit, delete and enable or disable them; builders see them read-only. A **Test a tool** form evaluates a project, role, server and tool, optionally with "No write tools", and shows the decision, the deciding rule and every matching rule.
- **Server Tools table.** An **Access** column shows **Read-only** or **Write** with its source: `annotation`, `manual`, or `unknown → write`. Admins pick **Mark read-only** or **Mark write**, or **Auto (annotation)** to let the server's annotation decide again. Tools your role cannot use in the active project show **Blocked for your role** with the rule's name.
- **MCP Tool node inspector.** A "Blocked for you by MCP tool policy" note appears when the selected tool (or, in all-tools mode, any discovered tool) is blocked for you in the workflow's project, naming the rule.
- **Editor ⋯ menu.** **No write tools** is a checkbox item for builders and admins; save the workflow to keep it.

## Permissions and audit

| Action | Role |
|---|---|
| List rules, dry-run a decision | builder and above |
| Create, update, delete rules; override a tool's classification | admin |

Changes are written to the audit log with resource type `mcp_policy` and events `mcp_policy.created`, `mcp_policy.updated`, `mcp_policy.deleted`, `mcp_policy.classification_set` and `mcp_policy.classification_cleared`.

## Endpoints

- `GET /api/mcp/policies`: rules in evaluation order, plus the roles a rule can target (builder)
- `POST /api/mcp/policies`: create a rule; `kind` is `tool` (default), `resource`, `prompt` or `sampling`; `annotationHint` is one of the conditions above, or `null`, and only applies to tool rules (admin)
- `PUT /api/mcp/policies/:id`: update any field of a rule (admin)
- `DELETE /api/mcp/policies/:id`: delete a rule (admin)
- `POST /api/mcp/policies/evaluate`: dry-run `{ projectId, role, serverId, toolName, kind?, noWriteTools? }`; `toolName` is the URI, prompt or model name for the other kinds. Returns the decision, the deciding rule, the matching rules, the denies a narrower allow set aside, and the tool's classification (builder)
- `PUT /api/mcp/servers/:id/tools/:toolName/classification`: `{ readOnly: true | false | null }`. `null` clears the override (admin)

## Storage

Rules are kept in `mcp_tool_policies` and overrides in `mcp_tool_classifications`. SQLite creates both at startup. On Postgres, migration v22 creates them and adds `workflows.created_by`; migration v24 adds the `annotation_hint` column; migration v25 adds `kind`.
