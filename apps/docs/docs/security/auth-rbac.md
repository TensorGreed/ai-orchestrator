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

Global roles set the ceiling. Project memberships (project admin, editor,
viewer, or a custom role) narrow it per project: a user without a membership in
a project falls back to their global role there, and a membership whose role
grants nothing locks them out of that project.

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

- Admins always pass.
- If you cannot read the workflow, the API answers `404`, the same as for an id
  that does not exist. If you can read it but lack the permission for the
  action, it answers `403`.
- Lists (workflows, executions, approvals, dead-letter queue, golden runs, eval
  runs, knowledge bases) only contain rows from projects you can read. They are
  filtered before paging, so totals never count other projects' runs.
- Runs of a deleted workflow are visible to admins only.
- A knowledge base without a project is shared across the deployment. One with
  a project can only be used by workflows in that project, both from the API
  and from a running `rag_retrieve` node.
- Session-mode chat and form triggers only answer users who can read the
  workflow's project.

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Error contracts

- `401` unauthenticated / invalid session
- `403` authenticated but unauthorized
- `404` not found, or in a project you cannot read
