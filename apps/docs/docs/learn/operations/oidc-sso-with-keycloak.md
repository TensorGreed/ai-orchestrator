---
title: "OIDC sign-in with Keycloak for a self-hosted AI tool"
sidebarTitle: "OIDC sign-in with Keycloak"
description: "A tested Keycloak walkthrough for OIDC sign-in: realm, client, redirect URI, groups claim, groups mapped to roles, MFA through the amr claim, logout."
level: intermediate
about: oidc
related: [oidc, sso, mfa, pkce, rbac]
---

# OIDC sign-in with Keycloak

To sign people in to a self-hosted AI tool with Keycloak, create a realm and a confidential OpenID Connect client whose redirect URI is the tool's callback, add a Group Membership mapper so the ID token carries a `groups` claim, and map those groups to roles in the tool. For MFA, have Keycloak put an `amr` claim in the ID token and let the tool refuse sign-ins that did not use a second factor. Every command below was run against Keycloak 26.8.2 and L2M while writing this guide.

The settings themselves are listed in [Authentication and RBAC: OIDC single sign-on](/security/auth-rbac#oidc-single-sign-on). This page is the Keycloak side, step by step, with the checks and the failures you will meet. For the wider picture (who is a user, who is a service account) see [Identity for AI platforms](/learn/operations/identity-for-ai-platforms).

## What you are building

| Keycloak | L2M |
|---|---|
| Realm `example`, issuer `http://localhost:8180/realms/example` | `OIDC_ISSUER` |
| Client `l2m`, confidential, PKCE S256 | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` |
| Valid redirect URI | `OIDC_REDIRECT_URL` (path `/api/auth/oidc/callback`) |
| Group Membership mapper, claim `groups` | `OIDC_GROUPS_CLAIM=groups` (the default) |
| Group `l2m-builders` | `OIDC_ALLOWED_GROUPS`, and a mapping to the `builder` role |
| AMR mapper, reference values on the login steps | `SSO_MFA=idp`, `SSO_MFA_OIDC_AMR` |

<Term id="sso">Single sign-on</Term> is optional in L2M. With `OIDC_ENABLED` unset, none of the `OIDC_*` settings are read and password sign-in works as before.

## Step 1: run Keycloak

For the walkthrough, run Keycloak in development mode with its official image. Development mode is for trying things out, not for production: it uses plain HTTP and a development database.

```bash
docker run -d --name keycloak -p 127.0.0.1:8180:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.8.2 start-dev
```

The admin console is at `http://localhost:8180/admin`. The commands below use `kcadm.sh`, Keycloak's admin CLI, inside the container, so they can be pasted as they are. Log it in first:

```bash
kc() { docker exec keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
kc config credentials --server http://localhost:8080 --realm master --user admin --password admin
```

L2M accepts a plain `http` issuer and redirect URL only on `localhost`. In production both must be `https`.

## Step 2: a realm and a client

```bash
kc create realms -s realm=example -s enabled=true

CID=$(kc create clients -r example -i \
  -s clientId=l2m -s protocol=openid-connect \
  -s publicClient=false -s standardFlowEnabled=true \
  -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false \
  -s 'redirectUris=["http://localhost:5173/api/auth/oidc/callback"]' \
  -s 'attributes={"pkce.code.challenge.method":"S256"}')

kc get clients/$CID/client-secret -r example     # the value for OIDC_CLIENT_SECRET
```

What each choice does:

- **`publicClient=false`** makes a confidential client with a secret. L2M sends it with `client_secret_basic`. A public client (no secret) also works; PKCE alone then protects the code.
- **`standardFlowEnabled`** is the Authorization Code flow, the only one L2M uses. Direct access grants (passwords sent by the app) and the implicit flow stay off.
- **`pkce.code.challenge.method=S256`** makes Keycloak refuse a login without a PKCE challenge. L2M always sends one, with `state` and `nonce`.
- **`redirectUris`** must hold the exact callback. OpenID Connect Core says the redirect URI "MUST exactly match" a registered one, by simple string comparison, so `localhost` and `127.0.0.1` are different URIs, and so are `http` and `https`.

The callback is `<WEB_ORIGIN>/api/auth/oidc/callback` by default, where the web app proxies `/api` to the API; in local development that is the Vite server on port 5173. Use the address people open in their browser, and avoid wildcards in Keycloak's redirect list.

## Step 3: put groups in the ID token

Keycloak sends no groups by default. Add a Group Membership mapper to the client (its dedicated scope):

```bash
kc create clients/$CID/protocol-mappers/models -r example \
  -s name=groups -s protocol=openid-connect \
  -s protocolMapper=oidc-group-membership-mapper \
  -s 'config={"claim.name":"groups","full.path":"false","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}'
```

Two settings matter:

- **`id.token.claim=true`.** L2M reads groups from the ID token. When the claim is missing there, it asks Keycloak's userinfo endpoint (hence `userinfo.token.claim=true`); putting it in the ID token saves that extra call.
- **`full.path=false`.** With the full path on, Keycloak sends `/l2m-builders` (and `/parent/child` for subgroups). Mappings and `OIDC_ALLOWED_GROUPS` compare names exactly, so `l2m-builders` would never match.

To use realm roles instead of groups, skip the mapper and set `OIDC_GROUPS_CLAIM=realm_access.roles`; L2M reads a dotted path as a nested claim.

## Step 4: a group and a user

```bash
GID=$(kc create groups -r example -s name=l2m-builders -i)
UID_=$(kc create users -r example -i -s username=alice -s email=alice@example.com \
  -s emailVerified=true -s enabled=true -s firstName=Alice -s lastName=Example)
kc set-password -r example --username alice --new-password 'change-me-Alice-1'
kc update users/$UID_/groups/$GID -r example -s realm=example -s userId=$UID_ -s groupId=$GID -n
```

`emailVerified=true` matters. L2M links an OIDC login to an account, or creates one, only when the token says the email is verified (`OIDC_REQUIRE_EMAIL_VERIFIED=true` by default). Keycloak sends `email_verified` from this flag. If the realm lets users register themselves or change their email, keep that default: it is what stops someone from claiming an address they do not own.

## Step 5: configure L2M

```bash
OIDC_ENABLED=true
OIDC_ISSUER=http://localhost:8180/realms/example
OIDC_CLIENT_ID=l2m
OIDC_CLIENT_SECRET=<the secret from step 2>
OIDC_REDIRECT_URL=http://localhost:5173/api/auth/oidc/callback
OIDC_ALLOWED_GROUPS=l2m-builders
```

`OIDC_ISSUER` must equal the `issuer` in `http://localhost:8180/realms/example/.well-known/openid-configuration`, character for character. The API checks the settings at start-up and refuses to start with a message naming the one that is wrong.

`OIDC_ALLOWED_GROUPS` is the gate. Without it (or `OIDC_ALLOWED_EMAIL_DOMAINS`), anyone the realm can authenticate gets an L2M account with the `viewer` role. That is acceptable for a realm that holds only your staff, and not for one with self-registration or social login.

Then map the group to a role. As an admin, under **Settings → Access control → SSO Mappings**, or with the API:

```http
POST /api/auth/sso/mappings
{ "provider": "oidc", "groupName": "l2m-builders", "role": "builder" }
```

A mapping without a project sets the global role on each login and never lowers it. One with `projectId` adds a project membership instead. Changing mappings asks an admin for a fresh confirmation (step-up) when step-up is on.

`GET /api/auth/oidc/metadata` shows what the API understood: issuer, client id, redirect URL, scopes and groups claim.

## Step 6: sign in and check

Open L2M and click **Sign in with SSO (OIDC)**. The browser goes to Keycloak with `response_type=code`, `code_challenge_method=S256`, `state` and `nonce`, then back to the callback and into L2M. `GET /api/auth/me` now shows `alice@example.com` with role `builder`, and the audit log has a `user.login` event with `"method": "oidc"`.

When we signed in with a second user who was not in `l2m-builders`, the browser came back to `/?sso_error=oidc_not_allowed`, and the audit log recorded `reason: "not_allowed"` with `list: "OIDC_ALLOWED_GROUPS"`. No account was created.

## MFA on SSO, with the amr claim

By default L2M does not ask SSO users for a second factor; it assumes the IdP's policy does. To make L2M check, Keycloak has to say in the token that a second factor was used. OpenID Connect defines `amr` as "identifiers for authentication methods used in the authentication". Keycloak sends no `amr` unless you add its AMR mapper and give each login step a reference value:

```bash
kc create clients/$CID/protocol-mappers/models -r example \
  -s name=amr -s protocol=openid-connect -s protocolMapper=oidc-amr-mapper \
  -s 'config={"id.token.claim":"true","access.token.claim":"true"}'

# Reference values on the browser flow's password and OTP steps
kc get authentication/flows/browser/executions -r example   # note the ids of auth-username-password-form and auth-otp-form
kc create authentication/executions/<password step id>/config -r example \
  -s alias=pwd-ref -s 'config={"default.reference.value":"pwd"}'
kc create authentication/executions/<otp step id>/config -r example \
  -s alias=otp-ref -s 'config={"default.reference.value":"otp"}'
```

In the admin console this is **Authentication → browser → the gear on each step**. Then in L2M:

```bash
SSO_MFA=idp
SSO_MFA_OIDC_AMR=otp
```

What we saw with this setup:

- Alice without an OTP device: Keycloak's default browser flow skips the OTP step for users who have none, the token carries no `otp`, and L2M sends her back with `sso_error=sso_mfa_required`.
- Alice after setting up an authenticator (Keycloak's **Configure OTP** required action): the next login asked for a code, the token carried `otp`, and the audit event recorded `"mfa": "idp", "mfaClaim": "amr", "mfaValue": "otp"`.

To make every user set up OTP, add **Configure OTP** as a required action for them, or as a default action for new users under **Authentication → Required actions**. If your users also hold local TOTP in L2M, `SSO_MFA=idp_or_local` accepts either. Keycloak's step-up flows with `acr` levels are another route; use `SSO_MFA_OIDC_ACR` for those. See [MFA on SSO](/security/auth-rbac#mfa-on-sso) for every option.

## Logout and offboarding

- **Signing out of L2M ends the L2M session only.** Keycloak's session stays (in our realm, 30 minutes idle and 10 hours at most by default), so clicking **Sign in with SSO** again goes straight through without a password. On a shared machine, sign out of Keycloak too, from its account console.
- **Disabling a user in Keycloak stops new sign-ins.** An L2M session already issued lasts until it expires (`SESSION_TTL_HOURS`, 168 by default) or is ended. For a leaver, disable the Keycloak user and end their sessions in L2M as well. If your identity provider can send SCIM, L2M's opt-in [SCIM provisioning](/security/scim) ends the sessions and revokes the API keys when the user is deactivated.
- **Removing someone from a group does not lower their global role.** Mappings raise roles; they never lower them. Change the role in L2M by hand when someone moves to a smaller role.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| Keycloak shows "Invalid parameter: redirect_uri" | The callback in Keycloak's redirect list differs from `OIDC_REDIRECT_URL`: scheme, host, port or trailing slash. |
| The API will not start, naming an `OIDC_*` setting | For example an `http` issuer on a host other than `localhost`, or a missing client id. The message names the setting. |
| `sso_error=oidc_unavailable` | L2M could not read Keycloak's discovery document: wrong `OIDC_ISSUER`, or Keycloak unreachable from the API host. It retries after 30 seconds. |
| `sso_error=oidc_email` | The user's email is not verified in Keycloak, or the token has no email. Set **Email verified** on the user. |
| `sso_error=oidc_not_allowed` | The user is in none of `OIDC_ALLOWED_GROUPS`, or the claim holds `/group` paths: turn **Full group path** off. |
| `sso_error=oidc_state` | The login took more than ten minutes, or was started twice in parallel. Start again. |
| `sso_error=sso_mfa_required` | `SSO_MFA=idp` and the token's `amr` has none of `SSO_MFA_OIDC_AMR`: check the AMR mapper and the reference values. |
| Role stays `viewer` | No mapping for that group name and provider `oidc`, or the mapper adds the claim to neither the ID token nor userinfo. |

The API log has the reason behind each `sso_error` code; the audit log has a `user.login` failure with a short reason.

## Try it in L2M

Run the commands above, start L2M with the Step 5 settings (`pnpm dev:product`), and sign in with SSO. The live demo has no sign-in, so this needs a local install; [Self-hosting an AI agent platform](/learn/operations/self-hosting-ai-agents) covers the rest.

## Further reading

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) (openid.net): ID token claims, `nonce`, `amr`, `acr`, redirect URI matching
- [Keycloak: getting started with Docker](https://www.keycloak.org/getting-started/getting-started-docker) and [Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html) (keycloak.org)
- [RFC 7636: PKCE](https://www.rfc-editor.org/rfc/rfc7636) and [RFC 8176: authentication method reference values](https://www.rfc-editor.org/rfc/rfc8176) (rfc-editor.org)
- L2M docs: [OIDC single sign-on](/security/auth-rbac#oidc-single-sign-on), [Linking accounts](/security/auth-rbac#linking-accounts), [Group-to-role mappings](/security/auth-rbac#group-to-role-mappings), [MFA on SSO](/security/auth-rbac#mfa-on-sso), [SAML single sign-on setup](/learn/operations/saml-sso-setup)
