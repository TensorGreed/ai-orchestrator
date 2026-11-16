---
title: "SCIM: provisioning users from an identity provider"
term: "SCIM"
topic: operations
definition: "System for Cross-domain Identity Management: a standard HTTP and JSON protocol an identity provider uses to create, update and deactivate user accounts and groups in other apps."
description: "SCIM (RFC 7643 and 7644) lets an identity provider create, update and deactivate users and groups in an app over HTTP. How it differs from SSO."
related: [sso, oidc, saml, rbac, service-account]
guide: [/learn/operations/identity-for-ai-platforms, /learn/operations/sso-vs-scim]
---

# SCIM

**System for Cross-domain Identity Management: a standard HTTP and JSON protocol an identity provider uses to create, update and deactivate user accounts and groups in other apps.**

<Term id="sso">Single sign-on</Term> answers "who is signing in right now?". It says nothing when someone leaves the company: their account in each app stays, and sessions or API keys already issued there can keep working. SCIM fills that gap: it tells each app, which can then end them. The identity provider (the SCIM client) pushes changes to each app (the service provider) as they happen: a new hire gets an account, a team change updates a group, a leaver is deactivated the same day.

SCIM 2.0 is specified in two IETF RFCs from 2015. RFC 7643 defines the schema: a core `User` (`urn:ietf:params:scim:schemas:core:2.0:User`) with attributes such as `userName`, `emails` and `active`, a `Group` with members, and an enterprise extension. RFC 7644 defines the protocol: JSON over HTTP (`application/scim+json`) on endpoints such as `/Users`, `/Groups`, `/Schemas` and `/ServiceProviderConfig`, with POST to create, GET with filters to search, PUT to replace, PATCH to change part of a resource, and DELETE.

Two identifiers matter. The service provider assigns `id`, and the client must not set it. The client may send `externalId`, its own id for the person, so both sides can match records later.

## Example

An employee leaves. The identity provider looks the user up and deactivates them:

```http
GET /scim/v2/Users?filter=userName eq "jo@example.org"

PATCH /scim/v2/Users/2819c223
Content-Type: application/scim+json

{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [ { "op": "replace", "path": "active", "value": false } ] }
```

The app can then end the account's sessions and keys at once, without waiting for anyone to notice.

## Common confusion

- **SCIM is not sign-in.** It moves account data; it never authenticates a user. Apps usually run SCIM next to OIDC or SAML, not instead of them.
- **Just-in-time provisioning is not SCIM.** Creating an account on first SSO sign-in covers joiners, but not leavers or role changes between sign-ins.
- **`active: false` is not always deletion.** RFC 7643 calls `active` the user's "administrative status" and leaves its exact meaning to the service provider. Many apps deactivate and keep the record for audit.

## In L2M

For how people get accounts and roles in L2M, see [OIDC single sign-on](/security/auth-rbac#oidc-single-sign-on), [group-to-role mappings](/security/auth-rbac#group-to-role-mappings), [user invites](/security/auth-rbac#user-invites) and [service accounts](/security/service-accounts).

## Further reading

- [RFC 7643: SCIM core schema](https://www.rfc-editor.org/rfc/rfc7643) (IETF)
- [RFC 7644: SCIM protocol](https://www.rfc-editor.org/rfc/rfc7644) (IETF)
