---
title: "SCIM provisioning: users and groups from your identity provider"
description: "SCIM 2.0 provisioning and deprovisioning of users and groups, group-to-role mappings, and immediate sign-out of deactivated users."
---

# SCIM provisioning

With SCIM 2.0 (RFC 7643 and RFC 7644) your identity provider creates, updates, deactivates and removes L2M accounts and
groups for you. A person your identity provider deactivates or removes is disabled at once: their sessions end and their
API keys are revoked in the same step. SCIM is optional and off by default; with it off, nothing changes.

## Turn it on

1. Set `SCIM_ENABLED=true` and restart the API. The SCIM endpoints are served at `/scim/v2`.
2. As an admin, open **Settings › Access control › Provisioning (SCIM)** and generate a token. It is shown once: copy it
   into your identity provider's provisioning settings as the bearer token. Only its SHA-256 hash is stored.
3. Give your identity provider the base URL, `https://<your-l2m-host>/scim/v2` (the page shows it when
   `APP_PUBLIC_URL` is set).
4. Optional: map groups to roles (see below). Without a mapping, a group grants nothing.

You can create the token before turning SCIM on. Creating, rotating and revoking a token are admin-only, need a recent
MFA check when [step-up](./auth-rbac.md) is on, and are audited (`scim_token.create`, `scim_token.rotate`,
`scim_token.revoke`).

| Route | What it does |
|---|---|
| `GET /api/scim` | Whether SCIM is on, the base URL, the tokens and counts |
| `GET /api/scim/groups` | Provisioned groups, member counts and the mappings that name each one |
| `POST /api/scim/tokens` | Creates a token: `{ "name": "identity-provider", "expiresInDays": 365 }` (shown once) |
| `POST /api/scim/tokens/:id/rotate` | A new token (shown once); the old one keeps working for `graceHours` (default 24, `0` ends it now) |
| `DELETE /api/scim/tokens/:id` | Revokes a token, and any older tokens it replaced that are still in their grace window |

The SCIM token works only on `/scim/v2`. It is not an API key: it cannot call `/api/*`, and an API key or a studio
session cannot call `/scim/v2`. Refused SCIM requests are audited as `scim.auth_failed` (at most once a minute per
address). [Network controls](./network-controls.md) can limit `/scim/v2` to your identity provider's addresses with
`NETWORK_ALLOW_SCIM`; requests count against the global rate limit.

## What is supported

| Endpoint | Methods |
|---|---|
| `/scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | `GET` |
| `/scim/v2/Users` | `GET` (filter, paging), `POST` |
| `/scim/v2/Users/:id` | `GET`, `PUT`, `PATCH`, `DELETE` |
| `/scim/v2/Groups` | `GET` (filter, paging), `POST` |
| `/scim/v2/Groups/:id` | `GET`, `PUT`, `PATCH`, `DELETE` |

- Requests and answers use `application/scim+json` (`application/json` is accepted too). Errors use the SCIM error
  schema with a `scimType` where RFC 7644 defines one.
- Filters: `eq` on `userName`, `externalId`, `id` and `emails.value` (also `emails[value eq "…"]`) for users;
  `displayName`, `externalId`, `id` and `members.value` for groups. `userName`, emails and group names compare without
  case. Other filters answer `400 invalidFilter`.
- Paging: `startIndex` (1-based) and `count` (default 100, at most 200).
- `PATCH` accepts `add`, `replace` and `remove` in any letter case; operations with no `path` and a value object
  (including dotted keys such as `name.givenName`); booleans sent as strings (`"False"`); `emails[type eq "work"].value`;
  and member removal by filter (`members[value eq "…"]`) or with a value list. Attributes L2M does not keep, such as
  enterprise extension attributes, are accepted and ignored.
- `excludedAttributes=members` and `attributes` on groups are honoured. A group `PATCH` answers `204 No Content` unless
  one of them asks for the group back; a user `PATCH` answers the user.
- Not supported: bulk operations, sorting, ETags, password changes, and `/Me`.

## Users

- `POST /Users` creates an account with the `viewer` role and an unusable random password: provisioned people sign in
  through SSO.
- If an account with that email already exists, `SCIM_LINK_EXISTING_USERS` decides. By default (`non_admin`) it is
  linked instead of duplicated, unless it is an admin's account. With `all`, admins' accounts are linked too; with
  `none`, nothing is linked. An account that is not linked answers `409 uniqueness`. A linked account keeps its email,
  password and roles, and from then on SCIM can disable it and raise its role through group mappings.
- The email is the primary email, else the first one, else the `userName` when it is an address.
- `PUT` and `PATCH` update the name, `externalId` and `active`. For accounts SCIM created, a new email follows; an
  account that was linked keeps its email.
- Service accounts are never provisioned or changed by SCIM.

## Deactivation and deprovisioning

`active: false` (by `PUT` or `PATCH`) disables the account:

- It cannot sign in with a password or through SSO (OIDC, SAML, LDAP): no new session is issued for it.
- All of its sessions end at once (shown as ended by an admin), and all of its API keys are revoked in the same
  transaction. A revoked key stays revoked if the account is enabled again.
- MCP gateway clients it created drop to the `viewer` role, as when their creator is deleted.
- Workflows it owns keep their schedules and webhooks. Hand them to someone else, or turn them off, if they should stop.
- `active: true` enables it again; the user can sign in, and needs new API keys.

`DELETE /Users/:id` deprovisions: the account is disabled the same way, the roles its groups gave are taken back, and it
leaves its groups. The account, its workflows and its history stay, and `GET /Users/:id` then answers `404`. If your
identity provider provisions the same person again, the same account comes back enabled.

Deactivations and deletes are audited (`scim.user.deactivate` with the number of sessions ended and keys revoked,
`scim.user.deprovision`), as are creates and updates (`scim.user.create`, `scim.user.update`, `scim.user.reactivate`).
Admins see disabled users marked **Disabled** under **Settings › Access control › Users**, and can enable one there
(`POST /api/users/:id/enable`, step-up action `user.enable`).

Two things are never cut off:

- **The last enabled admin.** SCIM cannot disable the only enabled admin; the request answers `400 mutability`. A
  disabled admin also does not count when L2M checks that an admin remains before a role change or a delete.
- **Break-glass sign-in.** A [break-glass](./auth-rbac.md) session from the server host still works for a disabled
  account, so you can recover if your identity provider disables the wrong person.

## Groups and roles

Groups are kept as your identity provider sends them. Members must be users SCIM provisioned; other ids are skipped.

A group grants roles only through a mapping. Make mappings under **Settings › Access control › SSO Mappings** with the
provider **SCIM groups** (`provider: "scim"` on `POST /api/auth/sso/mappings`). The mapping's group name matches the
group's display name, its SCIM id or its `externalId`.

- A mapping without a project sets the global role; with a project it sets the project role. When several mappings
  apply, the highest role wins (a custom project role applies only if no built-in role does).
- Mappings only raise roles. A mapping never lowers a role SCIM did not set: an admin in a group mapped to `viewer`
  stays an admin.
- Roles follow membership: they are applied when a user joins a group, a group is renamed, or a mapping is added. When
  the user leaves, the group is deleted, or the mapping is removed, the role the user had before SCIM raised it comes
  back (`viewer`, or no project membership, for a new account).
- An admin's change wins. If an admin changes a role by hand after SCIM set it, SCIM leaves it alone while the mapping
  still applies, and stops tracking it once the mapping no longer applies.
- It never demotes the last enabled admin.

Role changes are audited as `scim.user.roles_synced`; group changes as `scim.group.create`, `scim.group.update` and
`scim.group.delete`.

## Limits

- Updates for one user or group run one at a time on each API instance. With several instances behind a load
  balancer, two changes to the same user that land on different instances at the same moment can interleave; your
  identity provider's next sync corrects it.
- Up to 100 operations per `PATCH`, 10,000 members per request and 50,000 members per group.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SCIM_ENABLED` | `false` | Serves `/scim/v2` |
| `SCIM_LINK_EXISTING_USERS` | `non_admin` | Which existing accounts a new SCIM user links to by email: `non_admin`, `all` or `none` |
| `NETWORK_ALLOW_SCIM` | unset (open) | Addresses allowed to call `/scim/v2` |
