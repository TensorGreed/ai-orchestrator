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
With `SSO_MFA` unset, OIDC and SAML logins skip the local TOTP step and
`MFA_ENFORCE`, including for users who enrolled TOTP for password login. Either
require MFA for the L2M application in your IdP's policy, or set `SSO_MFA` (see
[MFA on SSO](#mfa-on-sso)).
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
affected.

| `SSO_MFA` | Behaviour |
|---|---|
| `off` (default, or unset) | No MFA check on SSO logins, as before. |
| `idp` | The login is accepted only if the IdP asserts MFA. Otherwise the browser returns to the login page with `sso_error=sso_mfa_required`; local TOTP is not offered. |
| `idp_or_local` | IdP-asserted MFA is accepted. Otherwise, a user with local TOTP enrolled gets the usual **Verification code** step (the same challenge as a password login: one attempt, five minutes) and has no session until the code passes. A user without TOTP is treated like a password login under `MFA_ENFORCE`: an admin (the role the login would end with, after group mappings) gets a session and is expected to enrol (recorded as `mfaEnrollmentRequired: true` in the `user.login` audit and, for a JSON SAML client, in the answer, as the password login does; the browser redirect carries no flag); anyone else is refused with `sso_mfa_required`. |

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
  sign in through SSO to enrol TOTP (except admins under `MFA_ENFORCE`). Use it
  when the IdP normally performs MFA and local TOTP is the fallback for
  accounts that already have it.

Example (Entra ID SAML, MFA required by the IdP):

```bash
SAML_ENABLED=true
SAML_IDP_ISSUER=https://sts.windows.net/<tenant-id>/
SAML_ALLOWED_GROUPS=<object id of the L2M users group>
SSO_MFA=idp
```

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/login/mfa` (`{ challenge?, code }`; an SSO login's challenge comes from the `l2m_sso_mfa` cookie)
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/oidc/metadata` (public; `{ "enabled": false }` when OIDC is off)
- `GET /api/auth/oidc/login` (browser navigation; redirects to the IdP)
- `GET /api/auth/oidc/callback` (IdP redirect target)
- `GET /api/auth/saml/login` (redirects to the SAML IdP)
- `POST /api/auth/saml/callback` (IdP form post, or JSON)

## Error contracts

- `401` unauthenticated / invalid session
- `403` authenticated but unauthorized
- `404` not found, or in a project you cannot read
