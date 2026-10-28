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

### Switching an existing install to `strict`

Under `strict` a non-admin sees nothing until they have a membership, and
default-project secrets stop being shared with every project. Before you
switch, as an admin:

1. Add memberships for every non-admin who should keep working, including to
   the default project for those who use it (`POST /api/projects/:id/members`,
   or Projects in the UI). Admins always keep access, so you cannot lock
   yourself out. If no user has any membership, the API logs a warning at
   startup.
2. Share each default-project secret to the projects whose workflows use it
   (`POST /api/secrets/:id/shares` with `{ "projectId": "..." }`). Until then,
   a run in another project fails with "belongs to another project". Do the
   same for registry MCP servers assigned to the default project, or move
   them to no project.
3. Jobs already on the queue run as the user who queued them; a job whose user
   has no access any more goes straight to the dead-letter queue.

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
| Answer an MCP elicitation | `workflow:execute` (seeing it needs `workflow:read`; a request from a run someone else started is shown only to that person and operators, except for queued runs, whose requests anyone who can read the workflow sees) |
| Eval datasets and fixtures: list or read / create, add, delete | `workflow:read` / `workflow:write` in the dataset's project |
| Compat webhook API (`/api/webhooks/execute`, `/stream`) | `workflow:execute` on the selected workflow |
| Create a template from a workflow / use a template | `workflow:write` on the source / `workflow:write` in the target project |
| Rename or delete a project | `project:manage` in that project (in `role` isolation, also a builder with no membership there) |
| Create or change a folder | `workflow:write` in that project |
| Create a secret | `secret:write`, or `workflow:write` and `secret:use`, in the target project (editors may create secrets in their project but not change, share or delete others') |
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
- A project can only be deleted once it has no workflows, secrets, knowledge
  bases, MCP servers and eval datasets left (`409` with the counts
  otherwise). Deleting it removes its folders, variables, memberships, custom
  roles and the shares into it, so a project created later with the same id
  starts empty.
- Running a workflow through an execute share needs `workflow:execute` in the
  project it is shared to; a viewer there can see it but not run it.
- API keys act as their owner, with the owner's memberships.
- A job a user put on the queue records that user as `triggeredBy` (a
  `triggeredBy` in the request body is kept as `customData.requestedBy`), and
  runs only if that user may still run the workflow when the job starts. If
  not, the job goes straight to the dead-letter queue (no retries) and a
  `queue.job_refused` audit event is recorded. The run uses that user's role
  for the MCP tool policy and their `secret:use`, as a direct run does. MCP
  elicitations from a queued run belong to the workflow: anyone with
  `workflow:execute` on it may answer them.
- Session-mode chat and form triggers only answer users who can read the
  workflow's project.

## What a running workflow can reach

Route checks decide who may start a run. Once it runs, a workflow is limited by
its own project, whichever trigger started it:

- **Sub-workflows and error workflows.** An `execute_workflow` node or a
  `settings.errorWorkflowId` may only call a workflow in the same project, a
  workflow with no project, or a workflow its owner shared to the caller's
  project with `execute` access. Who started, approved or retried the run does
  not matter: an admin approving a builder's paused run does not let it reach
  another project. Anything else fails the node with "Sub-workflow 'id' is in
  another project and is not shared to this workflow's project with execute
  access"; a refused error workflow is skipped and logged. A workflow with no
  project counts as the default project when it calls others. A sub-workflow
  runs with its own project's secrets, knowledge bases and session keys; the
  run's user carries over only to a child in the same project.
- **Secrets.** A `secretRef` resolves only for a secret of the workflow's
  project, shared to the workflow's project (`POST /api/secrets/:id/shares`),
  or, in `role` isolation only, of the default project. In `strict` isolation a
  default-project secret needs an explicit share like any other. When a
  signed-in user started the run, they also need `secret:use` in the
  workflow's project or in a project the workflow is shared to with `execute`.
  Admins are exempt from `secret:use`, not from the project rule. Provider,
  connector and MCP test and discovery routes only resolve a secret the caller
  has `secret:use` for in the secret's project or a project it is shared to.
- **Registry MCP servers.** A server assigned to a project can only be used by
  that project's workflows ("MCP server 'id' belongs to another project");
  servers with no project are deployment-wide, and default-project servers
  count as shared in `role` isolation only. The server's own `secretRef`
  follows the secret rules above.
- **Session memory, the session tool cache and session artifacts** are stored
  per project: two projects that pick the same Simple Memory namespace and
  session id never see each other's messages or cached tool results. Rows
  written before this scoping are still read, never written, by a workflow
  under its own exact default namespace (`<workflowId>:<nodeId>`) and, from
  the default project, under any namespace that no workflow of another project
  uses (as its default namespace or a literal custom one). Other projects stop
  seeing them; rows are not migrated.
- Deleting a workflow also deletes its versions, shares, queue and dead-letter
  rows, eval runs, elicitations and its legacy default-namespace session state
  (exactly `<workflowId>:<nodeId>` for its nodes), so a new workflow that
  reuses the id inherits none of it.

Triggers without a user (production webhooks, schedules, chat and form
triggers in public or bearer mode, the MCP gateway) are not checked against a
user, by design; they still get the run-time limits above.

## OIDC single sign-on

OpenID Connect login works alongside password, SAML and LDAP login. It is off
unless `OIDC_ENABLED=true`; with it unset nothing changes and none of the other
`OIDC_*` settings are read. When it is on, the login page shows **Sign in with
SSO (OIDC)** under the password form.

The API uses the Authorization Code flow with PKCE (S256), `state` and `nonce`.
The ID token must be signed with an asymmetric algorithm (RS*, PS* or ES*; `none`
and HS* are refused) by a key in the IdP's JWKS, and its `iss`, `aud` (your client
id), `azp`, `exp`, `iat` (60 seconds of clock skew, at most ten minutes old) and
`nonce` are checked. Discovery and the JWKS are cached for an hour; a token
signed with an unknown key id refetches the JWKS, so IdP key rotation needs no
restart.

| Setting | Default | Meaning |
|---|---|---|
| `OIDC_ENABLED` | off | Turns OIDC on. |
| `OIDC_ISSUER` | (required when on) | The IdP's `issuer`, exactly as its `/.well-known/openid-configuration` reports it (trailing slash included or not). Must be `https`; plain `http` only on `localhost`. |
| `OIDC_CLIENT_ID` | (required when on) | The client (application) id registered at the IdP. |
| `OIDC_CLIENT_SECRET` | unset | Confidential clients only; sent with `client_secret_basic` (or `client_secret_post` when that is all the IdP supports). Leave unset for a public client: PKCE alone then protects the code. Never logged or returned by the API. |
| `OIDC_REDIRECT_URL` | `<first WEB_ORIGIN>/api/auth/oidc/callback` | Register this exact URL at the IdP. It must reach the API on the same host the login started on (the web server proxies `/api` to the API). |
| `OIDC_SCOPES` | `openid email profile` | Must include `openid`. Add `groups` if your IdP needs a scope for the groups claim. |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim with the user's groups, for [group-to-role mappings](#group-to-role-mappings). A dotted path such as `realm_access.roles` reads a nested claim. |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | `true` | See [Linking accounts](#linking-accounts). |

The API checks these at startup and refuses to start with a clear message when
OIDC is on but misconfigured.

### Linking accounts

- An IdP account that has signed in before (same issuer, same `sub`) always
  gets the same L2M user, even if its email changed at the IdP.
- Otherwise the user is matched by email: an existing L2M user with that email
  is linked, or a new user is created (role `viewer` unless a mapping says
  otherwise). This happens only when the ID token (or the userinfo endpoint)
  says `email_verified: true`. An unverified email is never linked to an
  existing account and never creates one; the user sees "did not share a
  verified email address".
- Some IdPs (for example Microsoft Entra ID) do not send `email_verified`. If
  your IdP alone controls every email address in it, set
  `OIDC_REQUIRE_EMAIL_VERIFIED=false`; otherwise keep the default, because an
  unverified email would let anyone who can set that address at the IdP sign
  in as the matching L2M user.
- Users created through SSO get a random password, so they sign in through
  SSO only.

Sessions are the same as for password login (`SESSION_TTL_HOURS`, the session
cookie, `POST /api/auth/logout`). As with SAML, multi-factor authentication is
the IdP's job: the L2M TOTP step is not asked for SSO logins. Logout ends the
L2M session only, not the IdP session. Every OIDC login, successful or not, is
recorded in the audit log as `user.login` with `metadata.method = "oidc"` (the
failure reason is a short code; tokens are never logged).

When a login fails, the browser returns to the login page with a short
`sso_error` code (`oidc_state`, `oidc_denied`, `oidc_email`, `oidc_unavailable`
or `oidc_failed`) and the reason is in the API log. A login started in one
browser tab and finished more than ten minutes later, or started twice in
parallel, fails with `oidc_state`; start it again.

### Group-to-role mappings

Mappings for provider `oidc` work like the SAML and LDAP ones (Settings → SSO
group-to-role mappings, or `POST /api/auth/sso/mappings` with `"provider": "oidc"`). A
mapping without a project sets the user's global role on each login (never
lowering it); one with a project adds a project membership.

### Setting up an IdP

Register a web application (confidential client) or a single-page/native
application (public client), allow the Authorization Code grant, and add the
redirect URL. Then:

- **Keycloak**: `OIDC_ISSUER=https://<host>/realms/<realm>`. Add a "Group
  Membership" mapper to the client's dedicated scope with token claim name
  `groups`, "Add to ID token" on and "Full group path" off. Realm roles are at
  `OIDC_GROUPS_CLAIM=realm_access.roles`.
- **Microsoft Entra ID**:
  `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`. Under Token
  configuration add a groups claim (Entra sends group object ids, so map those
  ids). Entra does not send `email_verified` by default; read the linking
  rules above before setting `OIDC_REQUIRE_EMAIL_VERIFIED=false`.
- **Okta**: `OIDC_ISSUER=https://<org>.okta.com/oauth2/default` (a custom
  authorization server). Add a `groups` claim to the ID token on that
  authorization server, with a filter for the groups L2M should see.

Example (Keycloak, confidential client):

```bash
OIDC_ENABLED=true
OIDC_ISSUER=https://keycloak.example.com/realms/acme
OIDC_CLIENT_ID=l2m
OIDC_CLIENT_SECRET=<from the client's Credentials tab>
OIDC_REDIRECT_URL=https://l2m.example.com/api/auth/oidc/callback
COOKIE_SECURE=true
```

In production set `COOKIE_SECURE=true` (HTTPS) and give every API instance the
same `SECRET_MASTER_KEY_BASE64`: the short-lived login cookie that carries the
`state`, `nonce` and PKCE verifier is encrypted with a key derived from it, so a
login can start on one instance and finish on another.

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/oidc/metadata` (public; `404` when OIDC is off)
- `GET /api/auth/oidc/login` (browser navigation; redirects to the IdP)
- `GET /api/auth/oidc/callback` (IdP redirect target)

## Error contracts

- `401` unauthenticated / invalid session
- `403` authenticated but unauthorized
- `404` not found, or in a project you cannot read
