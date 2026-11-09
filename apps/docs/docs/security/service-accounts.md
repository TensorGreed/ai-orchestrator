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

## Audit

Every audit entry made with an API key has actor type `api_key` and records the key in its metadata
(`actorApiKeyId`), plus `actorServiceAccount: true` when a service account owns the key. Creating, changing and
deleting service accounts are audited as `service_account.create`, `service_account.update` and
`service_account.delete`; creating and revoking keys as `api_key.create` and `api_key.revoke`, with the owner's kind.

## Upgrading

Migration v62 adds `kind` (default `human`), `description` and `created_by` to `users`. Existing users are people and
existing keys keep working with their owner's role: their scopes, if any, were free-form strings, which stay legacy.
A key whose stored scopes already happen to read `role:<role>` or `project:<id>` starts being enforced.
`POST /api/auth/api-keys` now refuses scopes it used to store as free text when they look like a scope but are not
valid (`role:root`, a ceiling above the owner, an unknown project).

v62 also adds `requested_by_api_key_id` and `decided_by_api_key_id` to `approval_requests`. On Postgres, `users.kind`
has a check constraint (`human` or `service`). On both stores, any value other than `human` is read as a service
account, so an unexpected value never signs in.

### Rolling back

A build without v62 reads every key scope as free text and every user as a person, so rolling back as-is would widen
limited keys to their owner's full role and leave service accounts usable. The Postgres down migration of v62 closes
that before it drops the columns:

- it revokes every key of a service account, and every key whose scopes include a `role:` or `project:` entry;
- it disables each service account: role `viewer`, no project roles, no sessions, no usable password, and its email is
  rewritten to `<id>@disabled.invalid`, so no sign-in can reach it.

Nothing is widened; revoked keys have to be issued again after upgrading back. SQLite has no down migrations: before
running an older build on a SQLite database, revoke service-account keys and scoped keys yourself (for example under
**Settings › Access control › Service Accounts** and **Settings › Account › API Keys**). The random part of a service account's email
keeps an SSO login from reaching it even on an older build.
