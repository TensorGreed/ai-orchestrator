# Authentication and RBAC

## Session model

- Login creates a persisted session record in SQLite.
- API sets an `httpOnly` cookie (`SESSION_COOKIE_NAME`).
- Frontend uses `credentials: include`.

## Roles

- `admin`
- `builder`
- `operator`
- `viewer`

## Access model summary

- Workflow read: all authenticated roles
- Workflow create/update/delete: `builder`, `admin`
- Execute workflow/webhook API trigger: `builder`, `admin`
- Secrets list/create: `builder`, `admin`
- User registration:
  - first-user bootstrap or public registration (as configured)
  - `admin` can create admin users

## Project access

Project memberships (project admin, editor, viewer, or a custom role) set what a
user may do in a project. The global role is still checked by every route
first, so a membership cannot let a viewer call a builder-only route, but it can
grant more inside a project than the global role does (a global viewer who is
project admin of one project can manage that project's secrets). A membership
whose role grants nothing locks the user out of that project.

What happens in a project where a non-admin has no membership depends on
`PROJECT_ISOLATION`:

| `PROJECT_ISOLATION` | User without a membership in the project |
|---|---|
| `role` (default) | Gets their global role there. Existing installs keep working unchanged. |
| `strict` | Gets nothing: they only see projects they are a member of, the default project included. A non-admin who creates a project becomes its project admin. |

With `role`, isolation only exists where an admin has added memberships, so a
new project is open to every user until then. Use `strict` for deployments
where teams must not see each other's work. The value is validated at startup
(`role` or `strict`).

Every route that touches a workflow or its runs checks the workflow's project
on top of the global role:

| Action | Permission in the workflow's project |
|---|---|
| List or read workflows, versions, pins, variables, export | `workflow:read` |
| Create, update, import, move, duplicate, activate, restore, pin | `workflow:write` (on the workflow and on the project it lands in) |
| Delete a workflow | `workflow:delete` |
| Execute, stream, enqueue, manual trigger, retry, MCP replay, cancel, eval run | `workflow:execute` |
| Approve or reject a paused run | `workflow:execute` |
| Read executions, manifests, audit bundles, guard events, eval runs, golden runs | `workflow:read` |
| Save or delete a golden run / replay one | `workflow:write` / `workflow:execute` |
| Read or search a knowledge base / ingest into one | `workflow:read` / `workflow:write` in the KB's project |
| Read MCP cassettes (list, detail, export) | `workflow:read` on the recorded workflow |
| Answer an MCP elicitation | `workflow:execute` (seeing it needs `workflow:read`) |
| Eval datasets and fixtures: list or read / create, add, delete | `workflow:read` / `workflow:write` in the dataset's project |
| Compat webhook API (`/api/webhooks/execute`, `/stream`) | `workflow:execute` on the selected workflow |
| Create a template from a workflow / use a template | `workflow:read` on the source / `workflow:write` in the target project |
| Rename or delete a project, create or change a folder | `workflow:write` in that project |
| List, share, unshare or delete a secret | `secret:read` / `secret:write` in the secret's project |

- Admins always pass.
- If you cannot read the workflow, the API answers `404`, the same as for an id
  that does not exist. If you can read it but lack the permission for the
  action, it answers `403`.
- Lists (workflows, executions, approvals, dead-letter queue, golden runs, eval
  runs, knowledge bases) only contain rows from projects you can read. They are
  filtered before paging, so totals never count other projects' runs.
- Runs of a deleted workflow are visible to admins only.
- A knowledge base without a project is shared across the deployment: every
  user can read and search it, and every workflow can retrieve from it, but
  only an admin can add content to it. One with a project can only be used by
  workflows in that project, both from the API and from a running
  `rag_retrieve` node (which reports "Knowledge base not found" for any other).
- Eval datasets without a project are readable by everyone; changing them
  counts as a write in the default project.
- Templates are readable by every user, so a template never stores the source
  workflow's project, folder or pinned data. Using one creates the workflow in
  the default project, or in `{ "projectId", "folderId" }` from the request
  body when the caller can write there.
- A workflow's folder must belong to its project, and its project must exist.
- The project and folder lists only contain projects the user can read.
- Webhook endpoint and MCP toolset candidate lists only contain workflows the
  user can read. Recent MCP tool calls of runs the user cannot read keep their
  outcome but drop the workflow id and error text.
- API keys act as their owner, with the owner's memberships.
- A job a user put on the queue records that user as `triggeredBy` (a
  `triggeredBy` in the request body is kept as `customData.requestedBy`), and
  runs only if that user may still run the workflow when the job starts.
- Session-mode chat and form triggers only answer users who can read the
  workflow's project.

## What a running workflow can reach

Route checks decide who may start a run. Once it runs, a workflow is limited by
its own project, whichever trigger started it:

- **Sub-workflows and error workflows.** An `execute_workflow` node or a
  `settings.errorWorkflowId` may only call a workflow in the same project, a
  workflow with no project, a workflow shared to the caller's project with
  `execute` access, or (when a signed-in user started the run) one that user
  may execute. Anything else fails the node with "Sub-workflow 'id' is in
  another project and is not shared to this workflow's project with execute
  access"; a refused error workflow is skipped and logged. A workflow with no
  project counts as the default project when it calls others. A sub-workflow
  runs with its own project's secrets, knowledge bases and session keys.
- **Secrets.** A `secretRef` resolves only for a secret of the workflow's
  project, of the default project (shared), or shared to the workflow's project
  (`POST /api/secrets/:id/shares`). When a signed-in user started the run, they
  also need `secret:use` in the workflow's project. Admins are exempt from
  `secret:use`, not from the project rule. Provider, connector and MCP test and
  discovery routes only resolve a secret the caller has `secret:use` for in the
  secret's project or a project it is shared to.
- **Session memory, the session tool cache and session artifacts** are stored
  per project: two projects that pick the same Simple Memory namespace and
  session id never see each other's messages or cached tool results. Rows
  written before this scoping are still read, never written, by default-project
  workflows and by a workflow under its own default namespace
  (`<workflowId>:<nodeId>`); other projects stop seeing them.
- Deleting a workflow also deletes its versions, shares, queue and dead-letter
  rows, eval runs, elicitations and legacy default-namespace session state, so
  a new workflow that reuses the id inherits none of it.

Triggers without a user (production webhooks, schedules, chat and form
triggers in public or bearer mode, the MCP gateway) are not checked against a
user, by design; they still get the run-time limits above.

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Error contracts

- `401` unauthenticated / invalid session
- `403` authenticated but unauthorized
- `404` not found, or in a project you cannot read
