---
description: "MCP tool policy rules in L2M: allow, deny or require approval by role, server, tool, arguments and data labels, with shadow mode and gateway retries."
---

# MCP tool policy

Tool policy decides which MCP tools agents and MCP Tool nodes may use. It has three parts:

- **Rules.** Admins write allow, deny and require-approval rules scoped by project, role, server and tool name, and optionally by the call's arguments, the run's data labels, the workflow or the gateway client. A rule can run in shadow mode first.
- **Read-only classification.** Every tool is either read-only or a write tool, taken from an admin override or from the server's own annotations.
- **No write tools.** A per-workflow switch that blocks every write tool in that workflow.

Nothing changes on an existing install until an admin adds a rule: a tool that no rule matches is allowed.

Policy is enforced in the runtime, not only in the UI. Blocked tools are removed from an agent's tool set before the model sees it, and every call is checked again when it is made.

## Rules

Rules live under **MCP → Policies** in the sidebar.

| Field | Meaning |
|---|---|
| Effect | `allow`, `deny` or `require_approval` (tool rules only). See [Require approval](#require-approval). |
| Mode | `enforce` (the default) or `shadow`: a shadow rule is evaluated and recorded on every call, never applied. See [Shadow mode](#shadow-mode). |
| Conditions | Optional, tool rules only. Match only calls whose arguments or data labels meet them. See [Conditions](#conditions). |
| Workflows | Optional. Only runs of these workflows. Empty means any workflow, and gateway calls. |
| Gateway clients | Optional. Only these [MCP gateway](./mcp-gateway.md) clients: their direct calls and the workflow runs they start. Empty means any caller. |
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

The same evaluation order applies within a kind: no rule means allowed, deny wins, and an allow strictly inside a deny carves an exception. Conditions and `require_approval` exist for tools only.

### Evaluation order

For one tool call:

1. Collect the enabled, enforced rules whose scope matches the call. Project, role, server, tool pattern, annotation condition, workflows, clients and conditions must all match.
2. If no rule matches, the call is **allowed**. This is the default.
3. A matching deny rule is set aside when a matching allow or require-approval rule is **strictly narrower** than it. That is how a rule carves an exception out of a broader deny.
4. If any matching deny rule is left, the call is **denied**. The first such rule is reported, with rules taken oldest first.
5. Otherwise, a matching require-approval rule is set aside when a matching allow rule is strictly narrower than it. If one is left, the call **needs approval**.
6. Otherwise the call is **allowed**.

Precedence is deny, then require approval, then allow. A rule only beats a stricter rule it sits inside.

A rule is **strictly narrower** than another when it is inside the other in every field and smaller in at least one:

- **Project:** a specific project is inside "all projects", and inside the same project.
- **Roles:** a subset is inside a larger set. Any set is inside "every role", but "every role" is not inside a specific set.
- **Server:** a specific server is inside "any server", and inside the same server.
- **Tool pattern:** containment is checked conservatively. Anything is inside `*`, and an exact name is inside a glob that matches it. Two different globs are never treated as nested.
- **Annotation condition:** a rule with a condition is inside a rule without one, and inside a rule with the same condition. Two different conditions are never treated as nested.
- **Workflows and clients:** a non-empty list is inside an empty one (any), and inside a list that contains it.
- **Conditions:** a rule with conditions is inside a rule without any, and inside a rule with the same conditions (compared after sorting, so order does not matter). Two different sets of conditions are never treated as nested.

### Examples

**Viewers get one GitHub tool.** Rules: deny server `GitHub` for `viewer`, and allow tool `search_issues` on server `GitHub` for `viewer`. The allow is inside the deny and narrower in the tool, so viewers can call `search_issues` and nothing else on GitHub. Other roles are untouched.

**A broad allow does not override a narrow deny.** Rules: deny server `GitHub` for `viewer`, and allow tool `search_issues` on server `GitHub` for every role. The allow covers every role, so it is not inside the viewer-only deny. Viewers stay blocked from `search_issues`.

**No deletes in one project.** Rule: deny tool `delete_*` in project `Finance`. Every role loses `delete_issue`, `delete_file` and similar tools in that project only.

**No destructive tools for operators.** Rule: deny for `operator` with annotation condition **destructive**. Operators lose every tool that is not read-only and does not declare `destructiveHint: false`, on every server. Add an allow rule for `operator` on one tool name with the same condition to make an exception.

**Inline stdio servers off.** Rule: deny server `stdio_mcp`. Every stdio server configured inline on a node is blocked. Registered stdio servers are not affected, because an adapter id never matches a registry entry.

## Conditions

A tool rule can carry **conditions** on the call. The rule then matches only calls that meet them, on top of its other fields. Conditions are combined with **all** (every condition must hold) or **any** (at least one), up to 20 per rule.

| Operator | Matches when the value at the path... |
|---|---|
| `equals` | equals the value (a string, number, boolean or `null`) |
| `one_of` / `not_one_of` | is / is not one of a list of values (up to 100) |
| `starts_with` / `ends_with` | starts / ends with the text |
| `matches` | matches a glob: `*` any run of characters, `?` one character (at most 16 `*`) |
| `lt`, `lte`, `gt`, `gte` | is a number (or a numeric string such as `"5000"`) less than, at most, greater than, at least the value |
| `between` | is a number within `[min, max]`, both included |
| `exists` | is present and not `null`; with `value: false`, is absent |
| `label_present` / `label_absent` | (no path) the run's data carries / does not carry this provenance label or data class |

**Paths** name an argument: `repo`, `options.branch`, `files[0].path`, or `files[*].path` for every element of a list. A path that ends on a list reads its elements too, so `env one_of ["prod"]` sees `"env": ["prod"]`. Keys are letters, digits, `_`, `$`, `@` and `-`; a path has at most 16 steps.

**Values** compare the way a server would most likely read them. Text, numbers and booleans compare as trimmed text, so `5000` equals `"5000"` and `"prod "` equals `prod`; a number compares by value with a numeric string (`5000` equals `"5000.0"`). Number operators read numeric strings. Text comparisons are case-sensitive unless the condition has **Ignore case** (`ignoreCase: true`), which deny rules usually want: `PROD` is otherwise not `prod`.

### Conditions fail closed

A sloppy or unusual argument may cause an extra deny or approval, never an escaped deny or a wider allow. How a condition reads several values (a list) and a missing argument depends on the rule's effect:

| | Deny and require approval | Allow (exceptions) |
|---|---|---|
| Several values (`[*]`, or a path that ends on a list) | match when **any** value matches | match only when **every** value matches, and there is at least one |
| Missing argument, or `null` | matches `not_one_of` and `exists: false`; no other operator | matches `exists: false` only |
| An empty list | matches `not_one_of` only | never matches |
| A value the operator cannot read: an object or a nested list for any operator, text that is not a number (`"lots"`) for a number operator, text over 64 KiB for `matches` | matches | never matches |
| An element reached through `[*]` that lacks the rest of the path (`files[*].path` on `{"other": 1}`) or ends on an empty list | that element is skipped, like a missing argument | never matches |
| A reading cut short: more than 1,000 values at the path, a path that cannot be read, a value past the call's 1 MB of argument text, or the call's glob budget spent | matches | never matches |
| Run tracks no data labels | matches `label_absent` only | never matches |

For example, *deny `env` not one of `dev`* blocks a call that leaves `env` out, since the server may default to production: a missing argument "is not one of dev". A missing argument does **not** match the other operators: *deny `repo` starts with `evil/`* lets a call without `repo` through, and *deny `amount` greater than 100* lets a call without `amount` through, so optional arguments do not block every call. Add a second rule with `exists: false`, or use an allow-list, when a missing argument must not pass. *Deny `push`* with the exception *allow `push` where `repos[*]` starts with `myorg/`* still blocks `{"repos": ["myorg/a", "evil/b"]}`, because the exception needs every repository to match.

Padding a list does not help a caller either: *deny `repos[*]` starts with `evil/`* still blocks 1,000 harmless repositories followed by `evil/b`, because a reading past 1,000 values is cut short and matches. Each call's conditions read at most 1 MB of argument text in total, each value counted once however many rules read it; a value past that reads as cut short. Arguments no condition reads (a large file body next to the `path` your rule checks) do not count. Glob matching (`matches`) has a budget of 20 million comparison steps per call, across all rules; long values against a long pattern use it up, and the rest of the call's `matches` conditions then read as cut short. Shadow rules have budgets of their own, so a shadow rule never changes how an enforced rule reads the call.

Prefer allow-lists to deny-lists: deny broadly, then carve out exceptions with an allow rule that uses `one_of`. A deny-list has to foresee every spelling of the bad value; an allow-list only has to name the good ones. Values are compared as they are, after trimming spaces: lookalike characters (Cyrillic `р` for `p`, fullwidth `ＰＲＯＤ`) and invisible ones (a zero-width space) make a different value, so they slip past a deny-list but never into an allow-list.

**Labels** come from [data labels](./data-labels-and-destinations.md) on the run: the provenance labels and data classes the values flowing into the call carry.

In the rule form, add conditions row by row (argument path, operator, value). Values are kept as the text you type (`007` stays `007`); only `null` means null. The hint under the rows says how lists and missing arguments read for the effect you chose.

### Rules with invalid conditions

If a rule's stored conditions no longer parse or validate (limits tightened in an upgrade, or a hand-edited or restored database), the rule is listed with **Invalid conditions — fix or delete** and the API returns it with `invalid: true`. Until it is fixed it fails closed: an allow rule never matches, and a deny or require-approval rule applies to every call in its scope. The API logs a warning once per rule. Saving another change (a new name, shadow mode) leaves the stored conditions as they are, still failing closed; the API refuses to clear the conditions of an invalid allow rule, since that would allow every call in its scope. Enter new conditions, or delete the rule.

### Discovery and conditions

When an agent starts it lists its tools before any call is made, so there are no arguments yet. A rule with conditions is **undecided** at that point: a conditional deny or require-approval rule does not hide the tool, and a conditional allow can still carve an exception. The rule is applied to each call, with its arguments. A model that calls the tool with arguments a conditional deny matches gets a tool error naming the rule and the condition, for example `... is blocked by policy 'No prod pushes' (mtp_…) for role builder (the call matches: repo is one of "acme/prod").`

## Require approval

A `require_approval` rule lets the call go ahead only after a person approves it.

- **Agents and MCP Tool nodes.** The run pauses before the call, with a request in the **Approvals** inbox that names the tool, the server, the rule and the conditions the call matched. Approve it and the run resumes and makes the call once; reject it and the call fails. When the workflow's **Ask before write tools** switch also applies to the call, there is **one** request, which names both reasons.
- **Who decides.** An admin wrote the rule, so **admins** decide a policy approval, whatever approvers the workflow's write-tool settings name, and nobody approves their own run. The approval is bound to the rule (its id and hash): an approval the write-tool switch alone asked for never stands in for a policy approval, while a policy approval does cover the write-tool switch for the same call.
- **Gateway calls.** The client gets an "approval pending" error and retries after an admin approves. See [Gateway: approval by retry](#gateway-approval-by-retry).

The policy is checked **before** the guard: a call a rule denies or holds for approval never reaches the guard's argument checks. The **Ask before write tools** switch on its own keeps its place **after** the guard, so a call the guard blocks is never put to a person, and the person approves the arguments the guard let through. When the guard rewrites the arguments of a call a policy approval already covers, that approval still covers the rewritten call: one request.

### Gateway: approval by retry

A gateway client cannot wait inside one call, so a held-back gateway call returns a JSON-RPC error instead:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32030,
    "message": "Approval pending: MCP tool 'push' on server 'GitHub' needs approval by policy 'Prod pushes' (mtp_…). Ask an admin to approve request mga_…, then retry the same call with the same arguments.",
    "data": { "approvalRequestId": "mga_…", "status": "pending", "ruleId": "mtp_…", "ruleName": "Prod pushes", "expiresAt": "…", "approvalWindowMs": 900000 }
  }
}
```

Admins see the request under **MCP → Policies → Gateway approvals**, with the client, the tool, the rule and the arguments, and approve or reject it. After an approval, the **identical** call (same client, server, tool, and arguments, whatever their key order) goes through **once** within `MCP_GATEWAY_APPROVAL_WINDOW_MS` (default 900000, 15 minutes). A call with other arguments, from another client, after the window, or a second retry asks again. Asking again before a decision returns the same pending request. A pending request that nobody decides expires after 24 hours.

- **A rejection sticks.** After an admin rejects a request, the identical call is refused at once with JSON-RPC error **-32031** (`data.status: "rejected"`, the reason, and `retryAfter`, the decision time plus the approval window) and opens no new request. Once that window has passed, the identical call asks again. The first refused retry is audited (`mcp_gateway.approval_refused_rejected`), later ones are not.
- **At most 20 pending requests per client.** Past that, a call that would open a new request gets **-32029** "retry later" (`data.reason: "approval_requests_pending"`) until some are decided or expire, audited once per client per approval window (`mcp_gateway.approval_capped`). The identical call of a request already pending still gets that request back.
- **An approval is not lost to a refusal.** If the approved retry is refused before it reaches the server (rate limit, concurrency cap, open circuit), the approval is put back for a later retry inside the same window, also when the client cancelled the call while it waited for its turn. A cancelled call that went on to reach the server has used its approval. If two identical retries race, one runs and the other is told the approval was just used (`data.status: "used"`) instead of opening a new request.
- **Retention.** Decided and expired requests are deleted 30 days after they were made, and sooner with the run history retention.
- **Telemetry.** Gateway calls a rule denied, held for approval or refused after a rejection are in the audit log only: they have no tool-call telemetry row, so their `policy_decision_json` is never recorded. Rows exist for calls that ran (allow, shadow, approved).

## Shadow mode

A rule in **shadow** mode is evaluated on every call but never changes what happens. Each call records what the enforced rules decided and, when a shadow rule matched, what the outcome would have been with the shadow rules enforced too, and whether that would have changed it. Use it to try a rule on real traffic before you enforce it: switch the mode to **enforce** when the recorded decisions look right. The rule list marks shadow rules with a **Shadow** badge.

Every rule has a stable **hash** over what it matches (effect, scope, principals and conditions, not its name or mode), returned with the rule and written to its audit events, so you can tell whether an edit changed what a rule does.

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
- For `open_world` / `not_open_world`, the server's destination tier comes first. An admin's per-tool override wins. Vendor, public and unclassified servers are open world whatever `openWorldHint` says. On local and private servers the hint decides. See [Untrusted content and write tools](../guides/govern-mcp-tools.md#untrusted-content-and-write-tools).

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

Phase 12.4 adds `decisions`, one entry per call a rule matched:

```json
{ "tool": "push", "server": "github_mcp", "toolCallId": "call_1", "effect": "require_approval", "decidedBy": "rule", "ruleId": "mtp_…", "ruleName": "Prod pushes", "ruleHash": "…", "approval": "approved", "matched": [{ "ruleId": "mtp_…", "mode": "enforce", "effect": "require_approval" }], "shadow": { "effect": "deny", "ruleId": "mtp_…", "changed": true } }
```

The Trace tab shows them as lines such as `push: needs approval by policy Prod pushes (approved)` or `search: allowed; shadow rule Trial would make it blocked`. The same decision is stored with the call in [MCP tool telemetry](./mcp-server-registry.md#tool-telemetry) (`policy_decision_json`), for agents, MCP Tool nodes and gateway calls.

Traces never contain secret values.

## In the Studio

- **MCP servers page, Policies view.** Lists the rules in evaluation order, with their conditions in words and a **Shadow** badge on shadow rules. Admins add, edit, delete and enable or disable them; builders see them read-only. The form keeps description, kind, annotation condition and the workflow and client pickers under **Advanced**. A **Test a tool** form evaluates a project, role, server and tool, optionally with arguments (JSON), data labels, a workflow, a gateway client and "No write tools", and shows the decision, the matched rules and why, the rules that depend on arguments, and what shadow rules would do.
- **Gateway approvals.** On the same view, admins approve or reject gateway calls a require-approval rule held back.
- **Server Tools table.** An **Access** column shows **Read-only** or **Write** with its source: `annotation`, `manual`, or `unknown → write`. Admins pick **Mark read-only** or **Mark write**, or **Auto (annotation)** to let the server's annotation decide again. Tools your role cannot use in the active project show **Blocked for your role** with the rule's name.
- **MCP Tool node inspector.** A "Blocked for you by MCP tool policy" note appears when the selected tool (or, in all-tools mode, any discovered tool) is blocked for you in the workflow's project, naming the rule.
- **Editor ⋯ menu.** **No write tools** is a checkbox item for builders and admins; save the workflow to keep it.

## Permissions and audit

| Action | Role |
|---|---|
| List rules, dry-run a decision | builder and above |
| Create, update, delete rules; override a tool's classification | admin |
| List, approve and reject gateway approval requests | admin |

Changes are written to the audit log with resource type `mcp_policy` and events `mcp_policy.created`, `mcp_policy.updated`, `mcp_policy.deleted`, `mcp_policy.classification_set` and `mcp_policy.classification_cleared`; suggestions add `mcp_policy.suggestion_accepted`, `mcp_policy.suggestion_dismissed` and `mcp_policy.enforced` (see [Least privilege from real runs](../guides/least-privilege-from-real-runs.md)). Their metadata includes the rule's mode, conditions, workflows, clients and hash; updates also carry the previous hash. Gateway approvals add `mcp_gateway.approval_requested`, `mcp_gateway.approval_decided` and `mcp_gateway.approval_used`, and argument denials are `mcp_gateway.tool_denied` with the decision.

## Endpoints

- `GET /api/mcp/policies`: rules in evaluation order, plus the roles a rule can target (builder)
- `POST /api/mcp/policies`: create a rule; `kind` is `tool` (default), `resource`, `prompt` or `sampling`; `annotationHint` is one of the conditions above, or `null`, and only applies to tool rules; `conditions` is `{ "all": [...] }` or `{ "any": [...] }` of `{ path, op, value }`; `mode` is `enforce` or `shadow`; `workflowIds` and `clientIds` are lists of ids. Invalid input returns 400 with field-level `details` (for example `conditions.all.0.value`) (admin)
- `PUT /api/mcp/policies/:id`: update any field of a rule; the rule as updated must still be valid (admin)
- `DELETE /api/mcp/policies/:id`: delete a rule (admin)
- `POST /api/mcp/policies/evaluate`: dry-run `{ projectId, role, serverId, toolName, kind?, noWriteTools?, arguments?, labels?, workflowId?, clientId? }`; `toolName` is the URI, prompt or model name for the other kinds. Returns the decision and `effect`, the deciding rule, the matching rules with `why` (each rule's conditions in words), `undecided` rules (conditions without arguments), the `approval` when one is needed, the `shadow` outcome, the denies a narrower rule set aside, and the tool's classification (builder)
- `POST /api/mcp/policies/simulate`, `GET /api/mcp/policies/shadow-hits`, `GET /api/mcp/policies/suggestions`, `POST /api/mcp/policies/suggestions/generate`, `POST /api/mcp/policies/suggestions/:id/accept|dismiss|enforce` and `POST /api/mcp/policies/:id/enforce`: simulate drafts on recorded calls, count shadow hits and review least-privilege suggestions (admin); see [Least privilege from real runs](../guides/least-privilege-from-real-runs.md)
- `GET /api/mcp/gateway/approvals?status=`: gateway calls held for approval, newest first, with the approval window (admin)
- `POST /api/mcp/gateway/approvals/:id/approve` and `/reject`: decide a pending request, optionally `{ reason }`; 409 when it was already decided or expired (admin)
- `PUT /api/mcp/servers/:id/tools/:toolName/classification`: `{ readOnly: true | false | null }`. `null` clears the override (admin)
- `PUT /api/mcp/servers/:id/tools/:toolName/open-world`: `{ openWorld: true | false | null }`. Returns the resolved value and its source (`manual`, `destination`, `annotation` or `unknown`) (admin)
- `GET /api/mcp/policies/presets` (builder) and `POST /api/mcp/policies/presets/:presetId` (admin): list the safety presets, or add one in shadow mode (409 if already added)
- `GET` and `PUT /api/workflows/:id/untrusted-write-approval`: read or set `{ enabled }` for the workflow's "Approve writes only after untrusted content" switch (workflow read / write access; 409 when it would loosen an enforced rule)

## Storage

Rules are kept in `mcp_tool_policies` and overrides in `mcp_tool_classifications`. SQLite creates both at startup. On Postgres, migration v22 creates them and adds `workflows.created_by`; migration v24 adds the `annotation_hint` column; migration v25 adds `kind`. Migration v47 (both stores) adds `conditions_json`, `mode` (default `enforce`, so existing rules keep their meaning), `workflow_ids_json` and `client_ids_json`, the `policy_decision_json` column on `mcp_tool_calls`, and the `mcp_gateway_approvals` table, which follows the execution-history retention. Migration v50 adds the `mcp_tool_open_world_overrides` table and the `labels_json` column on `mcp_tool_calls` (the label names each call was decided with).
