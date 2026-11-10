---
description: "Service accounts for automation, and API keys scoped by a role ceiling and a project list."
---

# Service accounts and API keys

An API key is used as `Authorization: Bearer ao_…` on any API call. Every key belongs to an account: a person (a
personal key, made under **Settings › Account › API Keys**) or a service account. Both are optional: with no service
account and no key scope, keys work exactly as before.

## Service accounts

A service account is an identity for automation: CI pipelines, scripts, other services. It is managed by admins under
**Settings › Access control › Service Accounts**, or through the API.

- It has a global role and project memberships, like a person, and the same RBAC checks apply to it.
- It cannot sign in. It has no password, and password sign-in, OIDC, SAML, LDAP and invites all refuse it. Only its
  API keys authenticate it.
- Its email is `<name>+<random>@service.invalid`. The `service.invalid` domain is reserved (RFC 2606), so no person,
  invite or SSO login can claim it, and the random part means no identity provider can name the account either. Names
  are unique among service accounts.
- It never decides approvals: approval gates and approved tool calls need a person, so a service-account key cannot
  get round the approver or "no self-approval" rules. It does not count as "someone else who could approve" either.
- The admin who created it is recorded, but the account does not depend on that admin: deleting the admin leaves the
  service account and its keys working. A personal key, in contrast, stops working when its owner is deleted.
- Deleting a service account deletes its keys, project memberships and its own MCP OAuth connections.
- `GET /api/users` lists people; `GET /api/users?kind=service` lists service accounts.

| Route | What it does |
|---|---|
| `GET /api/service-accounts` | The service accounts, with their project roles and number of live keys |
| `POST /api/service-accounts` | Creates one: `{ "name": "ci-deployer", "role": "builder", "description": "…" }` |
| `PATCH /api/service-accounts/:id` | Changes its `role` and/or `description` |
| `DELETE /api/service-accounts/:id` | Deletes it with its keys |
| `GET /api/service-accounts/:id/keys` | Its keys |
| `POST /api/service-accounts/:id/keys` | Creates a key (the body below); the key is shown once |
| `DELETE /api/service-accounts/:id/keys/:keyId` | Revokes a key |
| `POST /api/service-accounts/:id/keys/:keyId/rotate` | Rotates a key (see [Rotating keys](#rotating-keys)); the new key is shown once |

Project memberships use the project member routes with the service account's id:
`POST /api/projects/:projectId/members` with `{ "userId": "<id>", "role": "editor" }`.

All of these need the admin role.

## Key scopes

A key can carry a scope. With none, it acts with its owner's role in every project the owner can reach, as keys always
did.

```json
{ "name": "deploy", "role": "operator", "projects": ["proj_payments"], "expiresInDays": 90 }
```

- **`role`**: a role ceiling. The key acts with the lower of its ceiling and its owner's current role, so demoting the
  owner also narrows the key. A ceiling above the owner's role is refused.
- **`projects`**: a project allow-list. The key reaches only these projects: everything in other projects reads as
  missing (`404`) or is left out of lists. Such a key:
  - acts as builder at most, because the admin role is global and cannot be held per project (asking for `admin`
    with a project list is refused);
  - can call only the routes that check projects: `GET /api/auth/me`, `GET /api/projects`, listing, reading,
    creating, updating and running workflows (`/api/workflows`, `/api/workflows/:id`, `…/execute`,
    `…/execute/stream`), the run history (`/api/executions`, `/api/executions/:id`, `…/events`, `…/retry`,
    `…/cancel`) and approvals (`/api/approvals`, `…/approve`, `…/reject`). Every other route answers `403`.
  - reaches a workflow of another project only when that workflow is shared to one of its projects.

The scope is stored with the key as strings (`role:operator`, `project:proj_payments`), and `scopes` in the create
body takes them directly. Any other string is a **legacy scope**: it is kept and shown as "legacy (not enforced)", and
changes nothing, as before.

A key created by a request that itself uses a scoped key cannot reach further than that key: it inherits the ceiling
and project list when none is given, and asking for more is refused. Any key made with another key (scoped or not)
also expires no later than the calling key, and the audit entry names the calling key (`createdWithApiKeyId`).

A service account's keys are made only by an admin, through `POST /api/service-accounts/:id/keys` (Settings › Service
Accounts). Its own keys cannot create keys (`POST /api/auth/api-keys` answers 403), so every key, and its expiry, is an
admin's decision.

A scoped key (one with a role ceiling or a project list) also cannot change its owner's account security: the MFA
routes (`/api/auth/mfa/enroll`, `/activate`, `/disable`) refuse it, and it can revoke only itself, not its owner's other
keys. Use a signed-in session, or an unscoped key, for those.

### Work that goes on later keeps the key's limits

When a key queues a run (`POST /api/workflows/:id/enqueue`), starts an eval or replay job, or decides an approval, the
key is recorded with that work. When the run starts or resumes later, it runs as the key's owner with the key's
ceiling and project list, not with the owner's full role. If the key has been revoked or has expired by then, the
work is refused as it would be for a deleted user: a queued run goes to the dead-letter queue, an eval case fails, and
an approval goes back to pending for someone else to decide.

## Rotating keys

Rotating a key gives you a new key and keeps the old one working for a grace window, so the callers that use it can
switch over without a coordinated deploy. Nothing changes for keys nobody rotates.

| Key | Route | Who |
|---|---|---|
| Your own key | `POST /api/auth/api-keys/:id/rotate` | The key's owner (an admin cannot rotate someone else's personal key: it would hand them that person's credential) |
| A service account's key | `POST /api/service-accounts/:id/keys/:keyId/rotate` | Admins |

The body is optional: `{ "graceHours": 24 }`. The old key keeps working for that many hours (0 to 168; 24 by default;
0 stops it at once), and never past its own expiry. The answer is `{ key, record, previous }`: the new key, shown once,
its record, and the old key's record with its new `expiresAt` and `supersededBy`. In the studio, **Rotate** on a key's
row asks for the window.

- **Same limits.** The new key has the old key's name and scope (role ceiling, project list, legacy strings), copied in
  the same transaction that retires the old key, so a rotation can never widen a key.
- **A fresh lifetime.** The new key gets the old key's lifetime again, counted from the rotation: a key made to last 90
  days and rotated on day 89 lasts 90 more days. That is never more than its owner could create: a key without an
  expiry gets none unless `API_KEY_DEFAULT_EXPIRY_DAYS` (or `SERVICE_ACCOUNT_KEY_MAX_AGE_DAYS`, below) is set, and a
  key rotated with a key expires no later than the calling key, as on create. A service account's key cannot create
  or rotate keys of its own account (`403`): only a person, or another account's key, renews it.
- **Once.** A rotated key cannot be rotated again (`409 { code: "already_rotated" }`); rotate its replacement. A
  revoked or expired key answers `409 { code: "inactive" }`. Two rotations of the same key at the same moment, on one
  instance or two, give one new key: the other request gets `already_rotated`.
- **Scoped keys** rotate only themselves, as they revoke only themselves. A key limited to projects cannot call the
  rotate routes at all (as for revoking); a service account's own key cannot rotate through the personal route.
- **Step-up.** Rotating needs a recent MFA check when step-up is on, like creating a key (action `api_key.rotate`), and
  a personal key is refused there. For an owner whose role requires MFA, rotating a personal key always needs an MFA
  check within 15 minutes, as creating one does.
- **Audit.** `api_key.rotate`, on the old key, with the new key's id and prefix, the grace window, the old key's new
  expiry, the owner's kind and, when a key made the request, `rotatedWithApiKeyId`. Never the key itself.

Keep the grace window short: during it, both keys work, so a leaked old key stays useful until the window ends. If the
old key leaked, rotate with `graceHours: 0`, or revoke it. Revoking the new key during the window also revokes the old
keys still in their window (as revoking a gateway client ends both its tokens); revoking the old key leaves the new one
working.

### Maximum age for service-account keys

```bash
SERVICE_ACCOUNT_KEY_MAX_AGE_DAYS=90   # 0 or unset = no limit
```

With a maximum age set, every new or rotated service-account key expires within that many days: a longer
`expiresInDays`, or none, is shortened to it. Personal keys are not affected. Keys made before the setting keep their
expiry; rotate them to bring them under it.

### Expiry warnings

The `credential.expiring` notification warns before a credential stops working:

- an API key (personal or a service account's) or a [gateway client](../product/mcp-gateway.md#rotating-a-clients-token)
  that expires within 7 days;
- a rotated key that is still being used after the rotation, when its grace window ends within 24 hours (a caller has
  not switched to the new key yet). A rotated key nobody uses any more ends quietly.

The leader instance checks every hour and sends each warning at most once a day per credential, across instances and
restarts. The message names the credential (name, prefix, owner, when it stops working), never the secret. Channels
made under **Settings › Notifications** receive it when they pick **Credential expiring**; channels set in the
environment receive it with `NOTIFICATIONS_CREDENTIAL_EVENTS=true`. With neither, nothing is sent. Key lists in the
studio show an "expires in N days" badge in the last 7 days, and "rotated, works until …" for an old key in its window.

## Step-up and MFA

With step-up on (`STEP_UP_MAX_AGE_MINUTES`), security-admin actions refuse personal API keys, because a key cannot
answer a code. A service account's key whose role ceiling is `role:admin` is let through, as long as the account is
still an admin and the key lists no projects; that is the key to give automation that changes roles, creates keys or
manages secrets. It is still refused on actions that target a person's account (resetting their MFA, signing them out,
changing their role or deleting them): those need a person who has passed a second factor. Creating a service-account key, changing a service account's role and deleting one need a recent MFA
check on the admin's session, like the same actions for people. `MFA_REQUIRED_ROLES` applies to people only: a service
account never signs in, so its keys are not refused when its role is listed. See
[Step-up for security actions](./auth-rbac.md#step-up-for-security-actions).

A service account never counts as the last admin: demoting the only person who is an admin is refused even when an
admin service account exists.

## Audit

Every audit entry made with an API key has actor type `api_key` and records the key in its metadata
(`actorApiKeyId`), plus `actorServiceAccount: true` when a service account owns the key. Creating, changing and
deleting service accounts are audited as `service_account.create`, `service_account.update` and
`service_account.delete`; creating, rotating and revoking keys as `api_key.create`, `api_key.rotate` and
`api_key.revoke`, with the owner's kind.

## Upgrading

Migration v62 adds `kind` (default `human`), `description` and `created_by` to `users`. Existing users are people and
existing keys keep working with their owner's role: their scopes, if any, were free-form strings, which stay legacy.
A key whose stored scopes already happen to read `role:<role>` or `project:<id>` starts being enforced.
`POST /api/auth/api-keys` now refuses scopes it used to store as free text when they look like a scope but are not
valid (`role:root`, a ceiling above the owner, an unknown project).

v62 also adds `requested_by_api_key_id` and `decided_by_api_key_id` to `approval_requests`. On Postgres, `users.kind`
has a check constraint (`human` or `service`). On both stores, any value other than `human` is read as a service
account, so an unexpected value never signs in.

Migration v64 adds `superseded_by`, `rotated_at` and `expiry_notified_at` to `api_keys`, and the previous token's
prefix, hash and expiry (plus `rotated_at` and `expiry_notified_at`) to `mcp_clients`. All are empty until someone
rotates, so keys and clients work as before.

### Rolling back

A build without v62 reads every key scope as free text and every user as a person, so rolling back as-is would widen
limited keys to their owner's full role and leave service accounts usable. The Postgres down migration of v62 closes
that before it drops the columns:

- it revokes every key of a service account, and every key whose scopes include a `role:` or `project:` entry;
- it disables each service account: role `viewer`, no project roles, no sessions, no usable password, and its email is
  rewritten to `<id>@disabled.invalid`, so no sign-in can reach it.

Nothing is widened; revoked keys have to be issued again after upgrading back. Rolling back v64 keeps rotated keys'
shortened expiry, and ends every old gateway token still in its grace window. SQLite has no down migrations: before
running an older build on a SQLite database, revoke service-account keys and scoped keys yourself (for example under
**Settings › Access control › Service Accounts** and **Settings › Account › API Keys**). The random part of a service account's email
keeps an SSO login from reaching it even on an older build.
