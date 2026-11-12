---
description: "Authentication and access control in L2M: session cookies, admin, builder, operator and viewer roles, projects, OIDC and SAML single sign-on, and MFA."
---

# Authentication and RBAC

## Session model

- Every sign-in (password, the MFA step, OIDC, SAML, LDAP) creates a persisted session record in the database
  (SQLite or Postgres). A password that still needs an MFA code creates no session until the code is accepted.
- API sets an `httpOnly` cookie (`SESSION_COOKIE_NAME`).
- Frontend uses `credentials: include`.
- A session lasts `SESSION_TTL_HOURS` (168 by default) from sign-in, unless the session policy below sets another
  lifetime for the user's role.
- Each session records how it was signed in (`password`, `oidc`, `saml` or `ldap`), the client address and user
  agent, when it last passed an MFA check, and, once it ends, why (`logout`, `expired`, `idle`, `evicted` or
  `admin`). Sessions created before
  this was recorded keep working; their fields are empty.
- The client address is kept only when it is a valid IPv4 or IPv6 address (behind a proxy it comes from
  `X-Forwarded-For`, see `TRUST_PROXY`); the user agent is cut to 512 characters.
- When a session ends (sign-out, expiry, or revoked), its client address and user agent are cleared at once.
- Ended sessions are deleted after `AUDIT_LOG_RETENTION_DAYS` (365 by default), the same window as the audit log;
  with `AUDIT_LOG_RETENTION_DAYS=0` they are kept, without address or user agent. Sign-in events stay in the audit
  log under its own retention.

## Session policy

Three optional settings limit how long sessions last and how many a user keeps. With none of them set, sessions
behave as before: no idle timeout, a lifetime of `SESSION_TTL_HOURS`, and no limit on sessions per user.

| Setting | Meaning | `0` |
| --- | --- | --- |
| `SESSION_IDLE_TIMEOUT_MINUTES` | Signs a session out after this many minutes without user activity. | no idle timeout |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | The longest a session lives after sign-in, whatever the activity. Falls back to `SESSION_TTL_HOURS`. | not allowed |
| `SESSION_MAX_PER_USER` | The most sessions a user keeps at once. | unlimited |

Each one takes a global value and optional per-role overrides, in the form `<global>[,role:value]*`:

```bash
SESSION_IDLE_TIMEOUT_MINUTES=60,admin:15
SESSION_ABSOLUTE_TIMEOUT_HOURS=168,admin:12
SESSION_MAX_PER_USER=5,admin:2
```

Either part may be left out (`admin:15` sets only admins). A malformed value stops the API at startup with an error
naming the setting and the entry. The settings are read-only in the studio: Settings > Security shows the values for
your role.

- **The current role applies.** Promoting a user to a role with a stricter value tightens the sessions they already
  have.
- **Only real activity counts toward the idle timeout.** The studio marks its background refreshes with the header
  `X-L2M-Background: 1`, and the server never counts those requests as activity. Your own scripts can send the same
  header. Activity is written at most once a minute per session, so the server allows one extra minute: a session
  ends between the configured idle time and one minute after it, never earlier. `GET /api/auth/me` returns that
  deadline (`idleExpiresAt`), and two minutes before it the studio asks whether to stay signed in.
- **Going over the session limit never refuses a sign-in.** The new session is kept and the user's oldest sessions
  end (reason `evicted`, audit event `session.evicted`). Signing in again in the same browser replaces that browser's
  session, so it never evicts another device. Sessions that are already idle or past their role's lifetime end first
  and are not counted. Break-glass sessions are neither counted nor ended by a normal sign-in; they skip the idle timeout too, but always
  end at their fixed expiry, which activity never extends. With several API
  instances the limit holds across them.
- **Why a session ended.** A request with an ended session gets `401` with `reason` (`idle`, `expired`, `evicted`,
  `admin`, `logout`); the studio's sign-in page explains it. The reason is reported to that session's cookie until the
  ended row is deleted (`AUDIT_LOG_RETENTION_DAYS`); an unknown cookie gets no reason.
- **Live-update streams close too.** A run, execution or eval event stream opened with a session checks it about every
  two heartbeats (`SSE_HEARTBEAT_INTERVAL_MS`). When the session has ended, the stream sends a `session_ended` event
  with the reason and closes. A run started from that stream keeps running.

### Signed-in sessions

Settings > Security lists your signed-in sessions (device, address, sign-in method, sign-in time, last activity). You
can sign out one session or all others. These two actions need a signed-in browser session: called with an API key
they answer `403` and end nothing. Admins can sign a user out everywhere from Settings > Access control > Users.
Sessions are named by a handle derived from the session, never by the session cookie itself. Ending sessions is
audited as `session.revoked`.

### Upgrading

Nothing changes until you set one of the settings. When you add an idle timeout, sessions that have already been idle
longer than it are signed out on their next request; users sign in again. Lowering
`SESSION_ABSOLUTE_TIMEOUT_HOURS` ends sessions older than the new value the same way.

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
- User registration (`POST /api/auth/register`):
  - the first user is the bootstrap admin
  - with `AUTH_ALLOW_PUBLIC_REGISTER=false` (the default) only an `admin`, signed in or with an API key, creates
    users, with any role
  - with `AUTH_ALLOW_PUBLIC_REGISTER=true`, a signed-out caller always gets `viewer`, whatever role it asks for; a
    signed-in user can give a role up to their own (a `viewer` creates viewers, a `builder` up to `builder`, an
    `admin` any role) and gets `403` above it; a request with an L2M API key (`Authorization: Bearer ao_...`,
    valid or not) gets `403`, while any other Bearer value (an auth proxy's own token, for example) is ignored.
    Refusals are audited as `user.register` with outcome `denied`.
  - `admin` can invite a user by email (see [User invites](#user-invites))

## User invites

An admin invites someone by email and role (`POST /api/users/invite`, see [Endpoints](#endpoints)). The invite creates
a **pending** user that already holds the role, so it can be added to projects at once, but it cannot sign in with a
password until it accepts. The invitee opens the link (`<web app>/#invite=<token>`), sees the email and role, chooses a
password of 8 characters or more and is signed in through the normal login (with MFA setup first when its role is
in `MFA_REQUIRED_ROLES`, see [MFA required per role](#mfa-required-per-role)).

- **The link.** The token is 32 random bytes; only its SHA-256 is stored. It works once and expires after 7 days unless
  the admin sets `expiresInHours` (1 to 720). The web app takes the token out of the address bar as soon as the page
  opens. The link starts with `APP_PUBLIC_URL`, or the first `WEB_ORIGIN` when that is unset.
- **Delivery.** With an SMTP server set in the environment (`NOTIFICATIONS_ENABLED=true` and
  `NOTIFICATION_SMTP_HOST`, the same settings as notification emails) the link is emailed to the invitee and not
  returned. Otherwise, or when the send fails, the answer carries `inviteUrl` once and the admin passes it on. Nothing
  new needs configuring.
- **Inviting again.** Inviting the email of a pending user sets its role and replaces its invite: the old link stops
  working. The email of an active account answers `409`.
- **Revoking.** Delete the pending user (`DELETE /api/users/:id`); its invite goes with it. `GET /api/users` marks
  pending users with `pending: true` and `inviteExpiresAt`.
- **Public registration.** Invites are an admin action, so they work the same whether `AUTH_ALLOW_PUBLIC_REGISTER` is
  on or off; turning it off does not stop them, and invites do not open registration to anyone else.
- **SSO.** L2M has no SSO-only switch: an invited user may accept with a password, or sign in with OIDC, SAML or LDAP
  instead. An SSO sign-in to the invited email links that pending user (by the usual [linking rules](#linking-accounts))
  and closes its invite, so the link no longer works. Deployments that sign everyone in through SSO usually do not
  need invites at all: SSO creates the account on first sign-in.
- **The link.** The token sits in the URL fragment (`#invite=`), which a browser never sends to a server, so web-server,
  proxy and load-balancer access logs and Referer headers never carry it. The page reads it and removes it from the
  address bar at once. A browser that is already signed in shows "Sign out to accept this invite" instead.
- **SSO claims by email.** An SSO sign-in claims a pending invite by the email the identity provider asserts, and the
  invited role (including `admin`) goes with it. Set OIDC `requireEmailVerified` to true and use SAML or LDAP only with a
  directory that verifies the email, so nobody can assert an invited address they do not own.
- **Audit.** `user.invite` (with `reinvite` and `emailed`) and `user.invite.accept` (success or failure).

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
| Read executions, manifests, audit bundles, rule events, eval runs, golden runs | `workflow:read` |
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
- API keys act as their owner, with the owner's memberships, unless the key carries a role ceiling or a project
  list: see [Service accounts and API keys](./service-accounts.md).
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
- Legal holds are managed by admins and by users with a deployment-wide custom role (one with no project) granting
  `legal_hold:manage`. The permission does nothing in a project role. Only an admin can assign a role that grants it,
  or remove or change the membership that carries it. Holds on a data subject are admin-only (placing one runs the
  data-subject lookup), and releasing a hold needs a signed-in person, not an API key. See
  [Legal holds](../operations/legal-hold.md).
- Data-subject requests are made by admins and by users with a deployment-wide custom role (one with no project)
  granting `data_subject:manage`. The permission does nothing in a project role, and only an admin can assign a role
  that grants it. See [Data-subject requests](./data-subject-requests.md).

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

## Break-glass sign-in

Break-glass sign-in is the way back in when no admin can sign in: the only admin is locked out, their authenticator
is lost, or SSO is down. It is a one-time link minted on the server host. Nothing exists until someone runs the
command, and nothing changes for deployments that never use it.

```bash
# On the API host, with the API's settings (the same .env or environment):
pnpm --filter @ai-orchestrator/api admin:break-glass -- --email admin@example.com [--minutes 15]

# Docker Compose: run it in the API container (`api-1` in docker-compose.prod.yml)
docker compose exec api pnpm --filter @ai-orchestrator/api admin:break-glass -- --email admin@example.com
```

The command prints `<APP_PUBLIC_URL>/#break_glass=<token>&email=<admin>` (the first `WEB_ORIGIN` when
`APP_PUBLIC_URL` is unset). Open it in a browser that can reach the studio. The page names the admin and the
one-hour session; **Sign in for one hour** sends the token to `POST /api/auth/break-glass` and signs you in.

- **The link** works once, for 5 to 60 minutes (`--minutes`, 15 by default). The token is in the `#` fragment, which
  browsers never send to a server, so it does not reach web-server or proxy access logs or a `Referer`. Opening the
  page uses nothing: a mail scanner, a chat link preview or a browser prefetch that fetches the link leaves it valid.
  Only the confirm button uses it. It is kept in the database, so the running API sees it on SQLite and on every
  instance of a cluster; only its SHA-256 is stored. Confirmed on two instances at once, it signs in once.
- **Cross-site requests are refused.** The confirm POST must come from the studio: an `Origin` must be one of
  `WEB_ORIGIN` or `APP_PUBLIC_URL`, and a browser request without one must be same-origin (`Sec-Fetch-Site`). A
  refused request does not touch the link and is audited. A client on the host with no browser headers (curl) is
  accepted.
- **Who** can be signed in: a human admin. Other roles, unknown emails and service accounts are refused. The account
  is checked again when the link is confirmed.
- **The session** lasts one hour from confirmation, is never renewed, and is marked break-glass (sign-in method
  `break_glass`). The sign-in policies (per-role MFA, step-up, session limits and idle timeouts) do not apply to it,
  so a locked-out admin can reach Settings to fix them. Its one-hour expiry always applies. The
  [network allowlists](./network-controls.md) still apply: a refused address never reaches the link, which stays
  unused.
- **The studio** shows a red banner for the whole session: "Break-glass session. Every action is recorded. It ends
  at HH:MM."
- **Audit**: `auth.break_glass_issued` (the command, with the host and OS user it ran as), `auth.break_glass_used`
  (the link confirmed, or refused with the reason), `auth.break_glass_request` for **every** request made in the
  session (method, route, status; not sampled) and `auth.break_glass_ended` (logout, expiry, or ended by an admin).
  These rows are written even with `AUDIT_LOG_ENABLED=false`, and they also go to the external log streams when
  those are on (the command sends its issue event there too).
  Rows carry a short reference to the session, never the link or the session ID.
- **Alerts**: the notification event `auth.break_glass_used` fires when the link is issued, when it is used and when
  the session ends. Channels set in the environment receive it automatically; on a channel made in Settings, pick
  **Break-glass sign-in**. The command reports what happened: which channels took the alert, which failed (a webhook
  that answers with an error counts as failed), or that **no channel receives the event, so nobody was alerted**.
  It still prints the link, since the outage that calls for break-glass may be what broke the channel. In the API the
  used and ended alerts go out in the background, at most 10 seconds per channel, so a stalled channel never holds
  up the sign-in. The audit log is the record either way.

Who may run it: anyone with shell access to the API host and its database settings (including
`SECRET_MASTER_KEY_BASE64`) can mint a link. That access already amounts to admin access, so the command adds no new
trust; restrict host access as you would the database.

What outlives the hour: the session ends after one hour, but what it created does not. API keys, invited or promoted
admins, changed roles, MFA resets and settings changes stay. Review them afterwards.

After using it:

1. Fix what locked the admin out (re-enrol MFA, correct the SSO or network settings, reset the password).
2. Sign out, or let the hour run out, and sign in normally.
3. Review the session's `auth.break_glass_request` rows in the audit log. Revoke any API key or access it created
   that should not stay, and record why break-glass was needed.
4. If the issued alert came as a surprise, treat it as an incident: someone has shell access to the host.

Break-glass sign-in is separate from [network break-glass](./network-controls.md#break-glass)
(`NETWORK_BREAK_GLASS_CIDRS`), which admits addresses outside a wrong allowlist but still needs a normal sign-in.
The two work together: from the host, the loopback range reaches the studio and the link signs you in.

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
restart. If a periodic JWKS refresh fails, the keys already cached stay in use,
and a failed discovery is retried after 30 seconds rather than on every click.

| Setting | Default | Meaning |
|---|---|---|
| `OIDC_ENABLED` | off | Turns OIDC on. |
| `OIDC_ISSUER` | (required when on) | The IdP's `issuer`, exactly as its `/.well-known/openid-configuration` reports it (trailing slash included or not). Must be `https`; plain `http` only on `localhost`. |
| `OIDC_CLIENT_ID` | (required when on) | The client (application) id registered at the IdP. |
| `OIDC_CLIENT_SECRET` | unset | Confidential clients only; sent with `client_secret_basic` (or `client_secret_post` when that is all the IdP supports). Leave unset for a public client: PKCE alone then protects the code. Never logged or returned by the API. |
| `OIDC_REDIRECT_URL` | `<first WEB_ORIGIN>/api/auth/oidc/callback` | Register this exact URL at the IdP. Its path must be exactly `/api/auth/oidc/callback` (no prefix or proxy rewrite, because the login cookie is scoped to `/api/auth/oidc`), with no query or fragment, and it must use `https` (plain `http` only on `localhost`). It must reach the API on the same host the login started on (the web server proxies `/api` to the API). |
| `OIDC_SCOPES` | `openid email profile` | Must include `openid`. Add `groups` if your IdP needs a scope for the groups claim. |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim with the user's groups, for [group-to-role mappings](#group-to-role-mappings). A dotted path such as `realm_access.roles` reads a nested claim. |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | `true` | See [Linking accounts](#linking-accounts). |
| `OIDC_ALLOWED_EMAIL_DOMAINS` | unset (any) | Comma list of email domains, such as `example.com,example.org`. A login is refused unless its verified email's domain is one of them (exact, case-insensitive match; `eu.example.com` does not match `example.com`). Checked on every login, for new and returning users. |
| `OIDC_ALLOWED_GROUPS` | unset (any) | Comma list of group names from `OIDC_GROUPS_CLAIM`. A login is refused unless the user holds at least one of them (exact match). Checked on every login, for new and returning users. |

::: warning Restrict who can sign in
Without `OIDC_ALLOWED_EMAIL_DOMAINS` or `OIDC_ALLOWED_GROUPS`, **any account
your IdP authenticates** gets an L2M account with role `viewer`, which can
already read workflows and executions. That is fine for an IdP that only holds
your organisation's staff. Set at least one allow-list (or restrict the
application's users at the IdP) when the IdP is shared or open: for example
`https://accounts.google.com`, a multi-tenant Entra ID app or one that admits
guests, or Auth0, Okta or Keycloak with social login or self-registration.
:::

The API checks these at startup and refuses to start with a clear message when
OIDC is on but misconfigured.

### Linking accounts

- An IdP account that has signed in before (same issuer, same `sub`) always
  gets the same L2M user, even if its email changed at the IdP. The link is
  stored per issuer: after you change `OIDC_ISSUER`, old links never match
  (a `sub` is unique only within one issuer), and users are matched again by
  verified email as below.
- Otherwise the user is matched by email: an existing L2M user with that email
  is linked, or a new user is created (role `viewer` unless a mapping says
  otherwise). This happens only when the ID token (or the userinfo endpoint)
  says `email_verified: true`. When the ID token has an email but no
  `email_verified`, the userinfo endpoint is asked, and its answer is used
  only for the same `sub` and the same email. An unverified email is never linked to an
  existing account and never creates one; the user sees "did not share a
  verified email address".
- Some IdPs (for example Microsoft Entra ID) do not send `email_verified`. If
  your IdP alone controls every email address in it, set
  `OIDC_REQUIRE_EMAIL_VERIFIED=false`; otherwise keep the default, because an
  unverified email would let anyone who can set that address at the IdP sign
  in as the matching L2M user.
- The first time an OIDC identity is linked to an L2M account that already
  existed (rather than one created by that login), the audit log records a
  separate `user.sso_linked` event with the provider, the user, the email and
  whether that user has local TOTP enrolled. Review these events: from then on,
  that account can be reached through the IdP.
- SAML links differently: it trusts the email the configured IdP asserts (see
  [SAML single sign-on](#saml-single-sign-on)).
- Users created through SSO get a random password, so they sign in through
  SSO only.

Sessions are the same as for password login (`SESSION_TTL_HOURS`, the session
cookie, `POST /api/auth/logout`); a session cookie the browser already held is
revoked when the SSO login issues a new one. Logout ends the L2M session only,
not the IdP session. Every OIDC login, successful or not, is recorded in the
audit log as `user.login` with `metadata.method = "oidc"` (the failure reason is
a short code; tokens are never logged).

::: warning By default SSO logins do not ask for MFA
With `SSO_MFA` unset, OIDC and SAML logins skip the local TOTP step, including
for users who enrolled TOTP for password login, unless the login's role is in
`MFA_REQUIRED_ROLES` (see [MFA required per role](#mfa-required-per-role)).
Either require MFA for the L2M application in your IdP's policy, or set
`SSO_MFA` (see [MFA on SSO](#mfa-on-sso)).
:::

The `code` and `state` on the callback URL are replaced with `REDACTED` in the
API request log and in HTTP server trace spans (the same applies to the MCP
OAuth callback).

When a login fails, the browser returns to the login page with a short
`sso_error` code (`oidc_state`, `oidc_denied`, `oidc_email`,
`oidc_not_allowed` for a login refused by an allow-list, `oidc_unavailable`,
`oidc_failed`, or `sso_mfa_required` (see [MFA on SSO](#mfa-on-sso))) and the reason is in the API log. A login started in one
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
  configuration add the `email` optional claim (Entra leaves it out otherwise)
  and add a groups claim (Entra sends group object ids, so map those ids).
  L2M does not read `xms_edov`, so it does not count as email verification. A
  user in more than 200 groups gets no `groups` claim at all (groups overage),
  so mappings and `OIDC_ALLOWED_GROUPS` do not see their groups; use app roles
  or assign groups to the application to stay under the limit.

  ::: danger Entra email is not verified
  Entra does not send `email_verified`, and its `email` claim is not verified
  by Entra: a user can often set it to any address, and for guests or
  multi-tenant apps the address is not controlled by your tenant. Setting
  `OIDC_REQUIRE_EMAIL_VERIFIED=false` is safe only for a **single-tenant app
  with no guest users**, where your tenant controls every address. Otherwise an
  attacker can take over the L2M account with a matching email.
  With `OIDC_REQUIRE_EMAIL_VERIFIED=false`, `OIDC_ALLOWED_EMAIL_DOMAINS` does
  **not** protect against a forged address in your own domain, because the
  address is trusted as sent. Rely on `OIDC_ALLOWED_GROUPS` and on IdP-side
  controls (restrict user assignment to the application, block guest sign-in)
  instead.
  :::
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

## SAML single sign-on

SAML 2.0 login is off unless `SAML_ENABLED=true` with `SAML_ENTRY_POINT`,
`SAML_ISSUER` (L2M's own entity ID), `SAML_CALLBACK_URL` and `SAML_IDP_CERT`. It
needs the optional `@node-saml/node-saml` package installed in `apps/api`
(`pnpm --filter @ai-orchestrator/api add @node-saml/node-saml@^5`); without it
the login and callback routes answer that SAML is not configured. L2M uses the
library's `getAuthorizeUrlAsync`, `validatePostResponseAsync` and the parsed
assertion of `profile.getAssertion()`, and was tested against 5.2.0 with a
signed response; use a 5.x release (`>=5.0.0 <6`). Start a login at
`GET /api/auth/saml/login`, or from the IdP (IdP-initiated).

The IdP posts the `SAMLResponse` to `POST /api/auth/saml/callback` (HTTP-POST
binding). The browser's form post is answered like the OIDC callback: a
redirect to the web app on success, or to the login page with a short
`sso_error` code (`saml_failed`, `saml_not_allowed`, `saml_unavailable`,
`sso_mfa_required`). An API client that posts JSON gets JSON answers instead
(`{ user, expiresAt, provisioned }`, `401`, or `403` with
`code: "saml_not_allowed"`). L2M has no Redirect-binding callback, so the
`SAMLResponse` only travels in the request body: it never appears in a URL,
request log line, trace span or audit entry.

| Setting | Default | Meaning |
|---|---|---|
| `SAML_GROUPS_ATTRIBUTE` | `groups` | Assertion attribute with the user's groups, for [group-to-role mappings](#group-to-role-mappings). |
| `SAML_IDP_ISSUER` | unset | The IdP's entity ID. When set, an assertion whose `Issuer` differs is refused. Must not contain `#`. |
| `SAML_ALLOWED_EMAIL_DOMAINS` | unset (any) | Same as `OIDC_ALLOWED_EMAIL_DOMAINS`, on the asserted email (or the NameID when it is the email). |
| `SAML_ALLOWED_GROUPS` | unset (any) | Same as `OIDC_ALLOWED_GROUPS`, on the groups from `SAML_GROUPS_ATTRIBUTE`. |
| `SAML_REQUIRE_IN_RESPONSE_TO` | `false` | Accept only answers to a login started at `GET /api/auth/saml/login` from the same browser; IdP-initiated sign-in is refused. See [Replay and unsolicited responses](#replay-and-unsolicited-responses). |

A login refused by an allow-list gets `saml_not_allowed`; both lists are
checked on every login, for new and returning users, exactly as for OIDC. The
API checks these settings at startup when SAML is on.

### Replay and unsolicited responses

- **Each assertion is accepted once.** L2M remembers the ID of every assertion
  it accepts (with its IdP's entity ID) in the database until the assertion
  expires: its `NotOnOrAfter` plus five minutes, at most 24 hours (an assertion
  without `NotOnOrAfter` is held for the 24 hours). A second post of the same
  `SAMLResponse` is refused with `reason: "replayed_assertion"`, on any API
  instance that shares the database. An assertion without an `ID` is refused
  (`missing_assertion_id`).
- **IdP-initiated sign-in and login CSRF.** By default the callback accepts any
  valid response, including one the IdP sends without a login started here
  (IdP-initiated, for example from the Entra ID "My Apps" portal). The trade-off:
  another user of the same IdP can have a page auto-post *their own* fresh
  assertion to the callback from your browser, signing your browser into
  *their* L2M account (login CSRF), so that work you then do lands in their
  account. Replay protection does not stop this, because the assertion is new.
- **`SAML_REQUIRE_IN_RESPONSE_TO=true`** closes it. `GET /api/auth/saml/login`
  then sets a ten-minute cookie (`l2m_saml_req`, HttpOnly, `Secure`,
  `SameSite=None`, path `/api/auth/saml`, sealed with a key derived from
  `SECRET_MASTER_KEY_BASE64`) holding the ID of the AuthnRequest it sends, and
  the callback accepts only an assertion whose `InResponseTo` equals that ID;
  the cookie is cleared on the callback. Responses without the cookie (another
  browser, an attacker's page), IdP-initiated responses and answers to another
  login are refused with `reason: "unsolicited_response"`. `SameSite=None` is
  needed because the IdP's form post is a cross-site request; browsers keep a
  `Secure` cookie only over https (and, in Chromium and Firefox, on
  `localhost`; Safari drops it on plain-http `localhost`), so the API refuses
  to start with this setting and a plain-http `SAML_CALLBACK_URL` on another
  host. There is one request cookie per browser: starting a sign-in in a second
  tab overwrites it, and the first tab then fails with `unsolicited_response`.
  Finish one sign-in before starting the next.
  Users must then start from L2M's login page, not from the IdP's portal.

### Linking SAML accounts

- A SAML identity is stored as `<IdP entity ID>#<NameID>`, taken from the
  assertion's `Issuer` (an assertion without an `Issuer`, or with `#` in it, is
  refused). The same NameID from another IdP never matches it. An identity that
  has signed in before keeps its L2M user, even if the asserted email changed.
- **Upgrade of existing links.** Identities recorded before this change hold
  the bare NameID. On that identity's next login L2M looks up the scoped key
  first, then the bare NameID. If it finds the old row, and the login passes
  the allow-lists and `SSO_MFA` (including the TOTP step), it rewrites the row
  in place to `<IdP entity ID>#<NameID>` (once; the audit `user.login` of that
  login has `identityUpgraded: true`). A refused login leaves the row as it
  was. Nothing needs to be migrated by hand. Because only one IdP is configured
  at a time, the first login after the upgrade binds the old link to that IdP.
- Otherwise the user is matched by email (the `email` or `mail` attribute, else
  the NameID): an existing L2M user with that email is linked, or a new user is
  created. Unlike OIDC there is no `email_verified` in SAML: **the configured
  IdP is trusted for the email it asserts**, because its signing certificate is
  pinned in `SAML_IDP_CERT`. Only connect an IdP whose users cannot choose an
  arbitrary email address, and use `SAML_ALLOWED_GROUPS` or IdP-side assignment
  to limit who can sign in.
- As for OIDC, the first link to an L2M account that already existed is
  audited as `user.sso_linked` (`provider: "saml"`, email, role,
  `mfaEnrolled`), and every login, successful or refused, is audited as
  `user.login` with `metadata.method = "saml"` and a short reason code.
- A browser's SAML sign-in cannot see the L2M session cookie it already holds:
  the IdP's form post is a cross-site request, which does not carry the
  `SameSite=Lax` session cookie. The new session replaces the cookie in the
  browser, but the earlier session is not revoked on the server; it ends at
  its normal expiry (`SESSION_TTL_HOURS`) or at logout. Sign out before
  switching accounts if the earlier session must end at once. (A JSON client
  that sends the cookie has it revoked, as with OIDC.)

## MFA on SSO

`SSO_MFA` decides whether an OIDC or SAML login must show multi-factor
authentication. It is read only when OIDC or SAML is on. LDAP login is not
affected by `SSO_MFA`; it follows the password login's rules (see
[MFA required per role](#mfa-required-per-role)).

| `SSO_MFA` | Behaviour |
|---|---|
| `off` (default, or unset) | No MFA check on SSO logins, as before, except for roles in `MFA_REQUIRED_ROLES`: those logins run as under `idp_or_local`, and a boot warning says so. |
| `idp` | The login is accepted only if the IdP asserts MFA. Otherwise the browser returns to the login page with `sso_error=sso_mfa_required`; local TOTP is not offered. |
| `idp_or_local` | IdP-asserted MFA is accepted. Otherwise, a user with local TOTP enrolled gets the usual **Verification code** step (the same challenge as a password login: one attempt, five minutes) and has no session until the code passes. A user without TOTP is treated like a password login under `MFA_REQUIRED_ROLES`: a listed role (the role the login would end with, after group mappings) gets a session that can only set up MFA (recorded as `mfaEnrollmentRequired: true` in the `user.login` audit and, for a JSON SAML client, in the answer, as the password login does; the browser redirect carries no flag); anyone else is refused with `sso_mfa_required`. |

What counts as IdP-asserted MFA:

| Setting | Default | Meaning |
|---|---|---|
| `SSO_MFA_OIDC_AMR` | `mfa` | OIDC: the ID token's `amr` (RFC 8176) contains one of these. Only `mfa` says that several factors were used (Entra ID, Okta, Auth0 and Ping send it after a second factor). The other RFC 8176 values name single methods: `otp` or `sms` alone can be a passwordless one-time code, `hwk`/`swk` a key on its own, `mca` several channels rather than factors, and `pwd`, `pin`, `kba`, `face`, `fpt` one factor each. If your IdP reports a second factor only as a method (for example `["pwd","otp"]`), list those methods, such as `SSO_MFA_OIDC_AMR=mfa,otp,hwk`. Keycloak sends no `amr` by default; use `SSO_MFA_OIDC_ACR` with its step-up levels instead. |
| `SSO_MFA_OIDC_ACR` | unset | OIDC: the ID token's `acr` is one of these. When set, L2M also sends them as `acr_values` to ask the IdP for that level. |
| `SSO_MFA_SAML_AUTHN_CONTEXTS` | see below | SAML: one of the assertion's `AuthnContextClassRef` values is in the list. |

The SAML default list is `https://refeds.org/profile/mfa`,
`http://schemas.microsoft.com/claims/multipleauthn` (Entra ID and AD FS after
MFA), `urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor`,
`urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract`,
`urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered` and
`urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI`. When `SSO_MFA` is on, L2M's
SAML request carries no `RequestedAuthnContext`, so the IdP reports the method
it really used rather than echoing a requested password class; enforce MFA in
the IdP's policy (for example Entra ID Conditional Access) for `idp` mode.

Only the signed ID token is read for `amr` and `acr` (never userinfo), and only
the validated assertion for `AuthnContextClassRef`. Settings with a bad value
stop the API at startup with a message naming the setting.

Notes:

- The IdP check happens before any account is created or linked, so a refused
  login changes nothing. In the TOTP step the identity is linked, group
  mappings are applied and the session is issued only after the code passes.
- The TOTP step reaches the web app through an HttpOnly cookie
  (`l2m_sso_mfa`, path `/api/auth/login/mfa`, five minutes) and the
  `?sso_mfa=totp` parameter; the challenge is never in the URL. A JSON SAML
  client gets `{ mfaChallenge, expiresInSeconds }`, like the password login.
- Pending challenges live in the API process, as for password logins: with
  several API instances, the callback and the code must reach the same
  instance (sticky sessions), or the code is refused and the user starts again.
- Audit: `user.login` records how MFA was satisfied: `mfa: "idp"` with
  `mfaClaim` (`amr`, `acr` or `authn_context`) and `mfaValue`, or
  `mfa: "local_totp"`, or `mfaEnrollmentRequired: true`. The TOTP step itself is
  `user.login.mfa_challenge`; a refusal is a `user.login` failure with
  `reason: "mfa_required"` and the `amr`/`acr` or `authnContext` values the IdP
  sent; a wrong code is `reason: "mfa_invalid"`. Never a token, assertion or
  code.
- Under `idp_or_local` a user without local TOTP and without IdP MFA cannot
  sign in through SSO to enrol TOTP (except roles in `MFA_REQUIRED_ROLES`). Use it
  when the IdP normally performs MFA and local TOTP is the fallback for
  accounts that already have it.

Example (Entra ID SAML, MFA required by the IdP):

```bash
SAML_ENABLED=true
SAML_IDP_ISSUER=https://sts.windows.net/<tenant-id>/
SAML_ALLOWED_GROUPS=<object id of the L2M users group>
SSO_MFA=idp
```

## MFA required per role

Users who enrolled TOTP are always asked for a code at sign-in. To require MFA for whole roles, list them:

```bash
MFA_REQUIRED_ROLES=admin,builder   # any of admin, builder, operator, viewer; unset = no role requires MFA
```

`MFA_ENFORCE=true` is an alias that adds `admin` to the list. An unknown role name refuses to start.
`MFA_ENABLED` has no effect (TOTP is always available); a boot note says so when it is set.

A user in a listed role who signs in without passing MFA is **restricted, never refused**, so nobody is locked out of
setting it up:

- **No authenticator yet.** Password, LDAP and SSO sign-ins issue a session that can only reach
  `GET /api/auth/me`, `/api/auth/mfa/*` and `POST /api/auth/logout`. Every other route answers
  `403 { code: "mfa_enrollment_required" }`, and the studio opens the setup screen (secret, backup codes, then a code
  to activate). Activating with a valid code lifts the restriction for the same session.
- **Authenticator set up, but this session has no MFA check** (a session from before the upgrade, or a user whose role
  was raised into a listed role): the session can reach `GET /api/auth/me`, `GET /api/auth/mfa/status`, sign-out and
  `POST /api/auth/step-up`. Everything else answers `403 { code: "mfa_verification_required" }`, and the studio asks
  for a code.

`GET /api/auth/me` returns `mfaEnrollmentRequired: true` or `mfaVerificationRequired: true` for a restricted session.
`GET /api/auth/mfa/status` adds `requiredForRole` and `stepUpMaxAgeMinutes`.

**API keys of a listed role.** A personal API key works only while its owner has an authenticator set up. If the owner
has none (never set up, or reset by an admin), every request with the key answers
`403 { code: "mfa_enrollment_required" }` until they set one up. Creating a key in a listed role always needs an MFA
check on the session within the step-up window, or within 15 minutes when step-up is off, because the key then works
without a code. The owner's own role decides, so a key capped below it (`role:viewer` on an admin) is covered too. Work a
key already started or decided before the rule applied to it (a queued run, an approval it decided, a run waiting on an
approval) still runs with that key's limits when it resumes: it was authorized when it was made. Revoke the key to stop
such work.

**Turning MFA off.** A user in a listed role cannot turn their own MFA off: `POST /api/auth/mfa/disable` answers
`409 { code: "mfa_required_for_role" }` (except from a break-glass session). A lost or replaced device goes through an
admin's [MFA reset](#resetting-a-users-mfa). For other roles, turning MFA off clears the current session's MFA check at
once and ends the user's other sessions.

**LDAP.** LDAP has no TOTP step of its own, so the password login's rules apply: a user with TOTP gets the code step
(`{ mfaChallenge }`, completed at `POST /api/auth/login/mfa`, the session is recorded with method `ldap`), and a listed
role without TOTP gets the setup-only session (`mfaEnrollmentRequired: true`).

**SSO.** See [MFA on SSO](#mfa-on-sso): with `SSO_MFA=off`, a listed role's OIDC or SAML login is accepted with
IdP-asserted MFA, else the local TOTP step, else the setup-only session. Unlisted roles sign in as before.

### Setting up an authenticator

Setting up an authenticator (`POST /api/auth/mfa/enroll`) needs a sign-in within the last 10 minutes, or the account
password again (`{ "password": "..." }`). Otherwise it answers `403 { code: "mfa_reauth_required" }`, and the studio
asks for the password. This keeps a stolen session cookie from binding the thief's authenticator to the account. An
account signed in through OIDC or SAML has no local password: the answer carries `sso: true`, and the user signs in
again through the identity provider, then sets MFA up within 10 minutes. Break-glass sessions are not asked.

### Wrong codes and reused codes

Five wrong codes for one user within 15 minutes (on the sign-in code step, `POST /api/auth/step-up` or
`POST /api/auth/mfa/disable`, counted together and across server instances) lock MFA verification for that user until
the oldest of those failures is 15 minutes old. While locked, those routes answer
`429 { code: "mfa_locked", lockedUntil }` with a `Retry-After` header, even for a correct code. The session that sent
the fifth wrong step-up code is ended (reason `policy`). Each wrong code is audited as `mfa.code_failed`, and the lock
as `mfa.locked`.

Each TOTP code is accepted once: a code from a time step at or before the last accepted one is refused, so a code seen
over someone's shoulder or in a log cannot be used again within its 90-second window. Backup codes were already
single-use.

**Upgrading with `MFA_ENFORCE=true`.** Before, the setting only flagged unenrolled admins at sign-in. Now it is
enforced: an admin without an authenticator is restricted to setting one up, and an admin's session from before the
upgrade asks for a code once.

## Step-up for security actions

```bash
STEP_UP_MAX_AGE_MINUTES=15   # 0 or unset = off
```

With step-up on, the actions below need an MFA check on the session within the last N minutes. A sign-in through the
TOTP step or with IdP-asserted MFA counts as a check at sign-in time. When the last check is older, the action answers
`403 { code: "step_up_required", stepUp: { action, method: "totp", enrolled, maxAgeMinutes } }`; the studio asks for a
code, sends it to `POST /api/auth/step-up` and retries the action once. A user without an authenticator is told to
set one up in **Settings > Security** first. Break-glass sessions are not asked.

| Action | Routes |
|---|---|
| Create a user | `POST /api/auth/register` (by an admin) |
| Invite a user | `POST /api/users/invite` |
| Change a user's role | `PUT /api/users/:id`, `PATCH /api/service-accounts/:id` (when the role changes) |
| Delete a user | `DELETE /api/users/:id`, `DELETE /api/service-accounts/:id` |
| Reset a user's MFA | `POST /api/users/:id/mfa/reset` |
| Sign another user out | `POST /api/users/:id/sessions/revoke` (not when it names your own account) |
| Turn your own MFA off | `POST /api/auth/mfa/disable` |
| Create an API key | `POST /api/auth/api-keys`, `POST /api/service-accounts/:id/keys` |
| Rotate an API key | `POST /api/auth/api-keys/:id/rotate`, `POST /api/service-accounts/:id/keys/:keyId/rotate` |
| Create a gateway client | `POST /api/mcp/clients` |
| Rotate a gateway client's token | `POST /api/mcp/clients/:id/rotate` |
| Create, change or delete a secret | `POST /api/secrets`, `PUT /api/secrets/:id/sensitive-output`, `POST /api/secrets/:id/shares`, `DELETE /api/secrets/:id/shares/:projectId`, `DELETE /api/secrets/:id` |
| Change SSO group mappings | `POST /api/auth/sso/mappings`, `DELETE /api/auth/sso/mappings/:id` |
| Change notification channels | `POST /api/notifications`, `DELETE /api/notifications/:id` |
| Change audit export destinations and log streams | `POST`, `PUT`, `DELETE` on `/api/audit-export/destinations` and `/api/log-streams` |
| Import MCP servers (creates secrets) | `POST /api/mcp/servers/import` |
| Add or remove a project member | `POST /api/projects/:id/members`, `DELETE /api/projects/:id/members/:userId` |
| Create, change or delete a custom role | `POST /api/custom-roles`, `PUT /api/custom-roles/:id`, `DELETE /api/custom-roles/:id` |
| Place or release a legal hold | `POST /api/legal-holds`, `POST /api/legal-holds/:id/release` |
| Change a project's data retention | `PUT /api/projects/:id/retention` |
| Make a data-subject export that reveals tokenised values | `POST /api/data-protection/requests` with `revealTokens: true` |
| Download a data-subject export | `GET /api/data-protection/requests/:id/export` |
| Confirm a data-subject deletion | `POST /api/data-protection/requests/:id/confirm` (a staff erasure of an existing account is admin-only and also needs the `user.delete` check, which refuses a service-account key) |

**API keys.** With step-up on, personal API keys are refused on these actions with `403 step_up_required`
(`stepUp.credential: "api_key"`): a key cannot answer a code, and a stolen personal key should not mint more keys or
change roles. Other routes work with keys as before. With step-up off, keys behave exactly as before. Automation that
performs these actions uses a [service account](./service-accounts.md): a service-account key whose role ceiling is
`role:admin` is let through, as long as the account is still an admin and the key lists no projects (a project list
caps a key at builder). Only an admin can give a key an admin ceiling.

Actions on a person's account are the exception: resetting someone's MFA, signing someone out, changing a person's role
and deleting a person need a person who has passed a second factor. With step-up on, a service-account key is refused
on them too (`stepUp.target: "person"`); the same actions on a service account still work with its admin key.

Every step-up is audited as `mfa.step_up` (success or failure).

## Resetting a user's MFA

An admin resets the MFA of a user who lost their authenticator from **Settings > Users > Reset MFA**, or with
`POST /api/users/:id/mfa/reset`. The user's authenticator and backup codes are deleted and all their sessions end
(reason `admin`); at their next sign-in they set MFA up again (restricted to setup if their role requires MFA). The
reset is audited as `mfa.reset` with the user's email, role, whether they had MFA and how many sessions ended. It needs
step-up when step-up is on. You cannot reset your own MFA, except from a break-glass session. The user's API keys are
not revoked (a lost device does not mean a leaked key); in a role that requires MFA they stop working until the user
sets up a new authenticator.

## Keeping admin access

No setting here refuses to start or refuses a sign-in outright: a listed role without MFA gets a setup-only session,
and step-up only asks for a code. The last admin cannot be demoted or deleted (`PUT` and `DELETE /api/users/:id` answer
`409 { code: "last_admin" }`), whoever asks, an admin service-account key included. Only people who can sign in count: an
invited admin who has not accepted yet does not, and can be demoted or deleted freely, and an admin service account
never counts (it cannot sign in or get a break-glass link). The count and the change happen in one transaction, so two
requests at the same moment cannot leave the workspace without one, and the break-glass command always has an admin to
sign in. A wrong-code lock (above) ends after 15 minutes on its own.

If the only admin loses their authenticator and backup codes:

1. **Another admin** resets their MFA (above).
2. **Break-glass from the server host**: `pnpm --filter @ai-orchestrator/api admin:break-glass --email <admin>` prints a
   one-time sign-in link for a one-hour session that skips the MFA requirement and step-up (every request in it is
   audited). From it, reset the admin's MFA, then sign out.
3. **Without break-glass**, with shell and database access on the host, delete the admin's authenticator row and sign
   in again, which leads to MFA setup:

   ```bash
   # SQLite
   node -e "const D=require('better-sqlite3'); new D(process.argv[1]).prepare(\"DELETE FROM mfa_secrets WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com')\").run()" \
     apps/api/data/orchestrator.db
   # Postgres
   psql "$DB_POSTGRESDB_URL" -c "DELETE FROM mfa_secrets WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com');"
   ```

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/login/mfa` (`{ challenge?, code }`; an SSO login's challenge comes from the `l2m_sso_mfa` cookie)
- `POST /api/auth/logout`
- `GET /api/auth/me` (with `session`: lifetime and idle deadline, null for an API key; `mfaEnrollmentRequired` /
  `mfaVerificationRequired` for a restricted session)
- `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:handle`, `POST /api/auth/sessions/revoke-others`
- `GET /api/users/:id/sessions`, `POST /api/users/:id/sessions/revoke` (admin, step-up; `{ handle? }`)
- `POST /api/auth/step-up` (`{ code }`, TOTP or backup code; refreshes the session's MFA check)
- `POST /api/auth/mfa/enroll` (`{ password? }`; the password is needed more than 10 minutes after signing in)
- `POST /api/users/:id/mfa/reset` (admin, step-up)
- `POST /api/auth/api-keys/:id/rotate` (your own key; `{ graceHours? }`, step-up; see
  [Rotating keys](./service-accounts.md#rotating-keys))
- `GET /api/auth/oidc/metadata` (public; `{ "enabled": false }` when OIDC is off)
- `GET /api/auth/oidc/login` (browser navigation; redirects to the IdP)
- `GET /api/auth/oidc/callback` (IdP redirect target)
- `GET /api/auth/saml/login` (redirects to the SAML IdP)
- `POST /api/auth/saml/callback` (IdP form post, or JSON)
- `POST /api/users/invite` (admin; `{ email, role?, expiresInHours? }`)
- `POST /api/auth/invite/lookup` (public; `{ token }`)
- `POST /api/auth/invite/accept` (public; `{ token, password }`)

## Error contracts

- `401` unauthenticated / invalid session (with `reason` when a session ended: `idle`, `expired`, `evicted`, `admin`,
  `logout`)
- `403` authenticated but unauthorized; with a `code` of `mfa_enrollment_required` or `mfa_verification_required`
  (a session restricted by `MFA_REQUIRED_ROLES`), `step_up_required` (a security action needs a recent MFA check),
  `mfa_code_invalid` (a wrong step-up code), `mfa_reauth_required` (setting up MFA needs the password or a fresh
  sign-in)
- `409` `last_admin` (demoting or deleting the only admin who is a person), `mfa_required_for_role` (turning MFA off in a listed role),
  `already_rotated` / `inactive` (rotating a key that was already rotated, or is revoked or expired)
- `429` `mfa_locked` (too many wrong MFA codes; `lockedUntil` and `Retry-After` say when to try again)
- `404` not found, or in a project you cannot read
