---
title: "Who can see and run what"
description: "L2M's access model on one page: roles, project membership, shares, own runs, session memory, API keys, service accounts, approvals and admins."
---

# Who can see and run what

This page puts L2M's access model on one page. The details are in [Authentication and RBAC](./auth-rbac.md) and
[Service accounts and API keys](./service-accounts.md).

## How a request is checked

1. **The global role.** Every route needs a role. Roles rank `viewer` < `operator` < `builder` < `admin`, and a higher
   role passes wherever a lower one does.
2. **The workflow's project.** Then the route checks a permission (such as `workflow:execute`) in the workflow's
   project. It comes from the person's project membership. Without one, it depends on `PROJECT_ISOLATION` (below).
3. **Shares.** A share can add read or run on one workflow. A share never gives edit, delete, publish or re-sharing.
4. **API keys.** A key acts as its owner. Its scope can narrow that, never widen it.

Both checks must pass. A membership cannot let a viewer call a builder route, and a role cannot reach a project the
person has no access to.

## The main table

What each kind of access gives on one workflow.

| Who | Reads it | Sees runs | Runs it | Changes it | Session memory of their runs |
|---|---|---|---|---|---|
| Admin | Yes, every workflow | All, also of deleted workflows | Yes | Yes | The workflow's |
| Builder with `workflow:write` in the project | Yes | All | Yes | Yes (delete and publish if the project role grants them) | The workflow's |
| Operator with `workflow:execute` in the project (an editor membership too) | Yes | All | The released version, with their own input | No | Their own |
| Viewer with `workflow:read` in the project | Yes | All | No | No | Their own (signed-in chat) |
| Member of a project the workflow is **shared to** | Yes | All | With an execute share, if they may run workflows in that project: the released version, with their own input | No | Their own |
| Person share, **Can view** | Yes | Only their own | No | No | Their own (signed-in chat) |
| Person share, **Can view and run** | Yes | Only their own | Operators and up: the released version. Viewers: no | No | Their own, also with a key of their own |
| API key | As its owner, within the key's scope | As its owner | The released version (the draft with `channel=draft` when it may edit the workflow) | As its owner, within the key's scope | The workflow's ([exceptions](./auth-rbac.md#running-workflows-by-role)) |
| Service account (through its keys) | As its role and memberships | As its role | As an API key | As its role | The workflow's |
| Webhook, schedule, public chat or form, MCP gateway | No user check | No user | Yes | No | The workflow's |

"Only their own" applies when the person share is all they have. See [Own runs only](#own-runs-only).

**Who may edit a workflow** is one rule everywhere: a global role of builder or higher **and** `workflow:write` on the
workflow. It decides who runs the draft (on `/execute`, the manual trigger route and a retry), who may use the editor's
run options, who may replay a run with its recorded MCP calls, who may replay golden runs, start replay jobs and eval runs (they
run the draft or a candidate), whose runs use the workflow's session memory, and who sees the editor's edit controls
(and, on the Runs page, Replay from here, Replay with the recorded MCP calls and the golden run controls). An operator with an editor membership may not edit: the role caps it.
A builder who may only run a workflow (through an execute share to their project, say) is treated like an operator
for it.

## Roles

| Role | In short |
|---|---|
| `viewer` | Reads workflows, runs and approvals. |
| `operator` | A viewer who may also run, queue and cancel runs, decide approvals and answer tools' questions. Cannot edit. |
| `builder` | An operator who may also create, edit, delete and publish workflows, retry and replay runs, and manage secrets and projects. |
| `admin` | Everything, including users, roles, single sign-on, policy and the audit log. |

Project roles set the permissions inside one project:

| Project role | Permissions |
|---|---|
| Project admin | Read, write, execute, delete and publish workflows; read, write and use secrets; manage the project and its members |
| Editor | Read, write, execute and publish workflows; read and use secrets |
| Viewer | Read workflows and secrets |
| Custom role | The permissions an admin lists in it |

- Only admins create, change and delete custom roles.
- A custom role with no project is deployment-wide. It is the only way to give a non-admin legal holds
  (`legal_hold:manage`) or data-subject requests (`data_subject:manage`). Only an admin may hand out such a role.
- A membership whose role grants nothing locks the person out of that project.

## Project isolation

`PROJECT_ISOLATION` decides what a non-admin gets in a project where they have no membership.

| Setting | Without a membership |
|---|---|
| `role` (default) | Their global role's permissions. Every project is open to every user until an admin adds memberships. |
| `strict` | Nothing. They see only projects they are a member of, and what is shared with them. |

Under `strict`:

- Default-project secrets and MCP servers need an explicit share, like any other project's.
- A non-admin who creates a project becomes its project admin.
- Someone in no project lands on Home with the workflows shared with them.

See [Project access](./auth-rbac.md#project-access) before switching an existing install.

## Shares

| | Project share | Person share |
|---|---|---|
| Gives | `read` or `execute` to the members of another project | **Can view** (`read`) or **Can view and run** (`execute`) to one person |
| Who manages it | `project:invite` in the workflow's project (who may add members), or an admin, with the member-change step-up | The same |
| Running through it | Needs `workflow:execute` in the project it is shared to | Needs a role that may run (operator and up). A viewer's run share only reads |
| Runs they see | All runs | Only their own, when the share is all they have |
| Not allowed | Sharing to the owning project | Yourself, service accounts, people without an account (invite them first) |

- A share never gives edit, delete, publish or the right to share it on.
- Runs through an execute share (either kind) may use the workflow's secrets, as runs of its own project do.
- Person shares go with the workflow or the person when either is deleted.
- A deactivated person's person shares give nothing until they are enabled again.

Details: [Sharing a workflow with people](./auth-rbac.md#sharing-a-workflow-with-people).

## Own runs only

Someone who has a workflow only through a person share sees only their own runs of it: the runs they started, and the
runs that used their session memory. It applies when they are not a member of its project with a role that reads it,
are not a member of a project it is shared to, and are not an admin.

- Anyone else's run answers `404`, as a missing run. Lists are filtered before paging.
- They see and decide only the approvals and tool questions of their own runs.
- Data built from many people's runs (golden runs and sets, captures, eval and replay runs, rule events, the
  dead-letter queue) leaves the workflow out.
- `GET /api/workflows/:id/access` answers `ownRunsOnly: true`.

It holds under both `PROJECT_ISOLATION` settings. Under `role`, the global role that opens every project to a
non-member does not count for a workflow shared with them: the person share decides, and they see their own runs.
Workflows that are not shared with them keep the view their role gives. A builder in that position can still edit and
publish the shared workflow through their role, but sees none of what is built from other people's runs: golden sets,
evals, release-gate reasons and replay captures. Add them to the project to give them those.

Details: [Own runs only](./auth-rbac.md#own-runs-only).

## Session memory

Session memory, the session tool cache and session artifacts are stored per project. Two projects never share them.

Some runs keep them to the person who runs:

- runs by anyone who has the workflow only through a person share, whatever their role, signed in or with a key of
  their own;
- runs by a signed-in person who may not edit the workflow: operators (also with an editor membership), builders who
  may only run it, and viewers in a signed-in chat.

These runs read and write under the person's own key. Another person who sends the same session id starts an empty
session. Sub-workflows, the error workflow, queued runs and the part after an approval keep the same person's key.

People who may edit the workflow (and admins), other API keys, service accounts, schedules and webhooks use the
workflow's sessions.

- A retry or replay keeps the run's owner. The owner's own retry continues their session. Anyone else's retry runs in a
  namespace of its own and reads none of the owner's memory.
- A run of a deleted person is not run again (`409`).
- A Simple Memory or Session Artifact namespace may not start with `~person:`. That prefix marks one person's sessions.

Details: [Running workflows by role](./auth-rbac.md#running-workflows-by-role).

## Running a workflow

- A signed-in person who may edit the workflow (builder role or higher and `workflow:write`) runs the draft. Everyone
  else runs the released version (the published one, or the saved workflow while nothing is published and no release
  gate is on), and gets `403` for `channel=draft`.
- Anyone who may not edit the workflow runs with their own input only. Editor options (`startNodeId`, single-node runs, pinned data,
  `nodeOutputs`, `sourceExecutionId`, `record`, or a graph sent with the request) answer `403` with `refusedOptions`.
- Their runs use no pinned data, and their timeout is at most `WORKFLOW_EXECUTION_TIMEOUT_MS`.
- Queueing and cancelling need operator and `workflow:execute`. Retry needs builder; a builder who may not edit the
  workflow retries on the released version, without the editor's options. Replaying a run with its recorded MCP calls
  needs someone who may edit the workflow.
- A queued job runs only if the person who queued it may still run the workflow when it starts.

Once a run is going, it reaches only its own project's secrets, MCP servers, knowledge bases and sub-workflows,
whoever started it. See [What a running workflow can reach](./auth-rbac.md#what-a-running-workflow-can-reach).

## API keys

- A key belongs to a person or a service account and acts as that account, with its memberships.
- **Role ceiling** (`role:operator`, for example): the key acts with the lower of the ceiling and the owner's role.
- **Project list** (`project:<id>`): the key reaches only those projects, acts as builder at most, and may call only
  the routes that check projects. Everything else answers `403`.
- A key made with another key cannot reach further than that key and expires no later.
- Work a key starts that goes on later (a queued run, an approval) keeps the key's limits.
- A personal key stops working when its owner is deleted.
- With step-up on, personal keys are refused on security actions (creating keys, changing roles and the like).

Details: [Key scopes](./service-accounts.md#key-scopes).

## Service accounts

- An identity for automation. Admins manage it.
- It has a global role and project memberships, like a person, and the same checks apply.
- It cannot sign in. Only its keys, made by an admin, authenticate it.
- It never decides approvals and cannot be the target of a person share.
- Its runs use the workflow's sessions.

Details: [Service accounts](./service-accounts.md#service-accounts).

## Approvals

To decide a paused run, a person needs all of these:

1. `workflow:execute` on the workflow, and on every workflow along the sub-workflow path to the gate.
2. To match the gate: a listed role (exact match), or being named in its users. With nobody listed, operator and up.
3. Not to have started the run, unless the gate allows self-approval (off by default).

- Service accounts never decide.
- Someone with own runs only decides only gates in their own runs.
- Roles and access are checked again when the decision is taken.
- The resumed run runs as the person who decided, inside the workflow's project.

Details: [Approvals](../product/approvals.md#who-can-see-and-decide-project-authorization).

## Admins

- Admins pass every project check and see the runs of deleted workflows.
- The gate's approver list and self-approval rule still apply to them.
- A run they start or approve still reaches only its workflow's project. Admins skip `secret:use`, not the project rule.
- An admin's key with a project list acts as builder at most.
- The last admin who can sign in cannot be demoted or deleted.

Details: [Keeping admin access](./auth-rbac.md#keeping-admin-access).
