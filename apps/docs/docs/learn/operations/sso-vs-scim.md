---
title: "SSO vs SCIM: sign-in vs provisioning for AI tools"
sidebarTitle: "SSO vs SCIM"
description: "SSO decides who can sign in; SCIM creates, updates and removes accounts and groups. Why offboarding needs both, explained with the protocols."
level: intermediate
about: scim
related: [scim, sso, oidc, saml, rbac, service-account]
---

# SSO vs SCIM

<Term id="sso">Single sign-on</Term> and <Term id="scim">SCIM</Term> solve different problems, and an AI platform that many people use needs an answer to both. SSO, through <Term id="oidc">OpenID Connect</Term> or <Term id="saml">SAML 2.0</Term>, answers "who is this person, right now?" each time someone signs in. SCIM, the System for Cross-domain Identity Management, answers "which accounts and groups should exist in this app?" by letting your identity provider create, change and deactivate them over HTTP, whether or not anyone is signing in. SSO alone handles joiners well: an account can be created on the first sign-in. It does not handle leavers. Disabling someone in the directory stops their next sign-in. It does not remove the account, end the sessions they already hold or revoke the API keys they created. Removing those is provisioning, and SCIM is the standard way to do it.

## Two questions, two protocols

| | SSO (OIDC or SAML) | SCIM 2.0 |
| --- | --- | --- |
| Question it answers | Who is signing in, and how did they prove it? | Which users and groups should exist, with which attributes? |
| When it runs | At sign-in, with the person present | Whenever the directory changes, with nobody present |
| Who starts it | The person's browser, redirected between app and identity provider | The identity provider (the SCIM client), calling the app's API |
| What travels | An ID token (a signed JWT) or a signed XML assertion | JSON resources: `User` and `Group`, over HTTP |
| Direction | Identity provider to app, through the browser | Identity provider to app, server to server |
| Standards | OpenID Connect Core 1.0; SAML 2.0 (OASIS) | RFC 7643 (schema) and RFC 7644 (protocol), IETF 2015 |
| What it cannot do | Remove an account, or end sessions and keys already issued | Authenticate anyone |

<figure>
<svg viewBox="0 0 640 260" role="img" aria-labelledby="scim-fig-title scim-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="scim-fig-title">The SSO path and the SCIM path</title>
  <desc id="scim-fig-desc">An identity provider on the left and an app on the right. The SSO path goes up through the person's browser at sign-in and carries an ID token or assertion. The SCIM path goes straight from the identity provider to the app's SCIM API and carries user and group changes when the directory changes.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="105" width="170" height="50" rx="8" fill="none" stroke="currentColor"/>
    <text x="105" y="135" text-anchor="middle">Your identity provider</text>
    <rect x="450" y="105" width="170" height="50" rx="8" fill="none" stroke="currentColor"/>
    <text x="535" y="135" text-anchor="middle">App (AI platform)</text>
    <rect x="240" y="20" width="160" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="320" y="45" text-anchor="middle">Person's browser</text>
    <path d="M150 105 L250 60" stroke="currentColor" fill="none"/>
    <path d="M390 60 L490 105" stroke="currentColor" fill="none"/>
    <text x="320" y="85" text-anchor="middle" font-size="12">SSO: ID token or assertion, at sign-in</text>
    <path d="M190 210 L450 210" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2" fill="none" stroke-dasharray="5 3"/>
    <path d="M105 155 L105 210 L190 210" stroke="currentColor" fill="none"/>
    <path d="M450 210 L535 210 L535 155" stroke="currentColor" fill="none"/>
    <text x="320" y="200" text-anchor="middle" font-size="12">SCIM: POST, PATCH, DELETE on /Users and /Groups</text>
    <text x="320" y="230" text-anchor="middle" font-size="12">sent when the directory changes, nobody signing in</text>
  </g>
</svg>
<figcaption>SSO goes through the browser while a person signs in. SCIM goes straight from the identity provider to the app, at any time.</figcaption>
</figure>

## What SSO does, and where it stops

With OIDC, the app redirects the browser to the identity provider, the person signs in there, and the app receives an ID token: in the words of the specification, "a security token that contains Claims about the Authentication of an End-User", represented as a JSON Web Token. With SAML, the identity provider posts a signed assertion back through the browser. Either way the app learns who the person is, and often their email and groups, at that moment.

Many apps use this to create accounts on demand. The first time someone signs in, the app creates an account from the token's claims, a pattern usually called just-in-time provisioning. Groups in the token can set the account's role on each sign-in. That covers joiners and many role changes, with nothing extra to run.

The gaps show between sign-ins:

- **Leavers.** When someone leaves, the identity provider stops issuing tokens for them. The app only notices if they try to sign in again. A session cookie issued yesterday still works until it expires. API keys the person created never pass through SSO at all.
- **Removed groups.** If a person moves out of the admins group, the app sees it on their next sign-in, if it re-reads groups and is willing to lower a role. Until then they keep the old role.
- **Accounts that never sign in.** An app that should list a team before its members first sign in, for example to assign them to projects or approvals, has nothing to list.

## What SCIM does

SCIM 2.0 is two IETF documents. RFC 7643 defines the schema: it "provides a platform-neutral schema and extension model for representing users and groups". A user is identified by the schema `urn:ietf:params:scim:schemas:core:2.0:User`, a group by `urn:ietf:params:scim:schemas:core:2.0:Group`, and an enterprise extension adds fields such as department and manager. RFC 7644 defines the protocol, "an HTTP-based protocol that makes managing identities in multi-domain scenarios easier to support via a standardized service."

The app (the service provider) exposes endpoints such as `/Users`, `/Groups`, `/Schemas`, `/ResourceTypes` and `/ServiceProviderConfig`. The identity provider (the SCIM client) calls them:

- `POST /Users` creates an account for a new hire.
- `GET /Users?filter=...` finds an existing one, for example by `userName`.
- `PATCH` changes part of a resource, with operations `add`, `remove` or `replace`.
- `PUT` replaces a resource; the RFC says "PUT MUST NOT be used to create new resources".
- `DELETE` removes a resource, though "Service providers MAY choose not to permanently delete the resource".

A team change is one call. Here the identity provider removes a person from a group:

```http
PATCH /scim/v2/Groups/e9e30dba
Content-Type: application/scim+json

{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [ { "op": "remove", "path": "members[value eq \"2819c223\"]" } ] }
```

Two details matter for offboarding. A user's `active` attribute is "a Boolean value indicating the user's administrative status", and RFC 7643 leaves its exact meaning to the service provider, so setting it to `false` may mean "suspended" in one app and "deleted" in another. And SCIM does not define how the client authenticates: the RFC says the protocol "does not itself define a SCIM-specific scheme for authentication and authorization". It says bearer tokens "MAY be used when combined with TLS and a token framework such as OAuth 2.0", and many apps issue the identity provider one long-lived token. Whoever holds that token can create accounts and change groups, so protect it like an admin credential.

## The offboarding gap, step by step

Take a builder who leaves on Friday at 17:00.

1. **With SSO only.** The identity provider disables the account at 17:00. The builder's laptop still holds a session cookie that lasts a week, and a CI job uses an API key they created. The session keeps working until it expires or someone ends it by hand. The key keeps working until someone finds it.
2. **With SSO and SCIM.** At 17:00 the identity provider also sends a SCIM deactivation. The app ends the account's sessions and revokes its keys at once, if it is built to. The CI job breaks on Friday evening rather than leaking quietly for months, which is why automation should run under a <Term id="service-account">service account</Term> and not a person's key.

SCIM only delivers the message. What the app does with `active: false` decides whether the gap closes. Ask any vendor or project: does deactivation end sessions? Revoke API keys? Remove project memberships? Hand over scheduled work?

## When to use which

- **SSO alone** suits a small team, short sessions and a habit of removing leavers by hand. Keep session lifetimes short so that a disabled directory account locks the person out soon.
- **SSO plus SCIM** suits anything with many users, frequent team changes, admin roles managed in the directory, or audits that ask how quickly leavers lose access.
- **SCIM alone** is rare. Some apps receive accounts by SCIM and sign people in with a password or another method, but most pair it with SSO.

## How they combine

Run both against the same identity provider, and match them on stable keys. An OIDC account is identified by issuer and `sub`; a SAML account by the issuer and `NameID`. SCIM has its own pair: the `id` the app assigns, and an optional `externalId` that RFC 7643 defines as "an identifier for the resource as defined by the provisioning client". Decide which field links a SCIM user to an SSO identity before you turn either on, or you will end up with two accounts per person.

Decide which side owns roles. If groups arrive both in tokens at sign-in and through SCIM, they should say the same thing. A common split: SCIM creates accounts and keeps group membership current; SSO only signs people in. Role mapping from groups then happens in one place, and <Term id="rbac">role-based access control</Term> follows the directory. For the wider picture of who may build, run and approve, see [identity for AI platforms](/learn/operations/identity-for-ai-platforms). For how the two SSO protocols differ, see [SAML vs OIDC](/learn/operations/saml-vs-oidc).

## In L2M

L2M, a self-hosted workflow builder and agent runtime, supports OIDC, SAML 2.0 and LDAP sign-in, all optional. It has no SCIM endpoint. Accounts come from SSO sign-ins, invites or an admin. What it does today:

- **Accounts on first sign-in.** An OIDC or SAML sign-in that matches no account creates one, with role `viewer` unless a group mapping says otherwise ([OIDC single sign-on](/security/auth-rbac#oidc-single-sign-on)).
- **Allow-lists on every sign-in.** `OIDC_ALLOWED_GROUPS` and `OIDC_ALLOWED_EMAIL_DOMAINS` (and the SAML equivalents) are checked on every login, for new and returning users, so removing someone from the allowed group at the identity provider refuses their next sign-in.
- **Group mappings.** A mapping without a project sets the global role on each login but never lowers it; one with a project adds a project membership ([group-to-role mappings](/security/auth-rbac#group-to-role-mappings)). Lowering a role or removing a membership is a manual change.
- **Ending access now.** An admin can sign a user out everywhere from **Settings → Access control → Users**. Deleting the user (`DELETE /api/users/:id`) removes the account with its sessions, API keys, SSO identities and project roles in one transaction.
- **Shorter windows.** `SESSION_IDLE_TIMEOUT_MINUTES` and `SESSION_ABSOLUTE_TIMEOUT_HOURS` limit how long a session outlives its last use ([session policy](/security/auth-rbac#session-policy)).
- **Passwords next to SSO.** Accounts that SSO creates get a random password. L2M has no SSO-only switch, so an account that was given its own password, for example through an invite, can still use it until it is deleted.
- **Automation off people.** [Service accounts](/security/service-accounts) cannot sign in and are not tied to an employee, so deleting a leaver does not break a pipeline that uses a service account key.

So an L2M offboarding today is: disable the person at the identity provider, then delete the account in L2M (or at least sign it out everywhere). The [audit log](/security/audit-log) records the sign-out (`session.revoked`) and the deletion (`user.delete`).

## Further reading

- [RFC 7643: SCIM Core Schema](https://www.rfc-editor.org/rfc/rfc7643) (IETF): `User`, `Group`, `active`, `externalId`
- [RFC 7644: SCIM Protocol](https://www.rfc-editor.org/rfc/rfc7644) (IETF): endpoints, methods, PATCH operations, authentication
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) (OpenID Foundation): the ID token
- [SAML V2.0 Technical Overview](https://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html) (OASIS): assertions and the Web Browser SSO profile
- L2M docs: [Authentication and RBAC](/security/auth-rbac), [Service accounts and API keys](/security/service-accounts)
