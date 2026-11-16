---
title: "SAML single sign-on for AI tools: a working setup"
sidebarTitle: "SAML single sign-on setup"
description: "Set up SAML 2.0 sign-in end to end: entity IDs, ACS URL, NameID, signed responses and assertions, clock skew, replay protection and groups mapped to roles."
level: advanced
about: saml
related: [saml, sso, mfa, rbac]
---

# SAML single sign-on: a working setup

A SAML 2.0 sign-in needs five values to agree on both sides: the service provider's entity ID, its Assertion Consumer Service (ACS) URL, the identity provider's sign-on URL, the IdP's entity ID and the IdP's signing certificate. The IdP posts a signed response to the ACS URL, the service provider checks the signature, the audience, the time window and that the assertion was never used before, and then maps the user's groups to roles. Three common causes of a failed setup are an unsigned assertion, clocks that disagree, and a NameID nobody expected.

This guide sets up SAML sign-in to L2M with Keycloak 26.8.2 as the example IdP; we ran it end to end while writing this page. The reference for every setting is [Authentication and RBAC: SAML single sign-on](/security/auth-rbac#saml-single-sign-on). For OpenID Connect instead, which is simpler when your IdP offers both, see [OIDC sign-in with Keycloak](/learn/operations/oidc-sso-with-keycloak).

## The pieces of a SAML sign-in

The OASIS technical overview describes SAML as roles exchanging XML messages. For browser sign-in, that is:

| Term | Meaning | In this setup |
|---|---|---|
| Identity provider (IdP) | Authenticates the person and issues the assertion | Keycloak realm `example` |
| Service provider (SP) | The application that trusts the assertion | L2M |
| SP entity ID | The SP's unique name; the IdP addresses the assertion to it (the audience) | `SAML_ISSUER=l2m-saml` |
| ACS URL | Where the IdP posts the response (HTTP-POST binding) | `SAML_CALLBACK_URL=…/api/auth/saml/callback` |
| IdP sign-on URL | Where the SP sends the browser with its `AuthnRequest` | `SAML_ENTRY_POINT=…/realms/example/protocol/saml` |
| IdP entity ID | The `Issuer` of the IdP's assertions | `SAML_IDP_ISSUER=…/realms/example` |
| IdP signing certificate | The key the SP uses to check signatures | `SAML_IDP_CERT` |
| NameID | The subject's identifier in the assertion | an email address here |
| Metadata | XML that describes an IdP or SP: endpoints, bindings, keys | Keycloak publishes it; L2M does not |

A sign-in started at the SP is **SP-initiated**: L2M sends an `AuthnRequest`, and the response carries `InResponseTo` with that request's ID. A sign-in started from the IdP's portal is **IdP-initiated**, and its response is **unsolicited**: the SAML profiles specification says it "MUST NOT contain an InResponseTo attribute". The difference matters for security, below.

## Step 1: install the SAML library

SAML in L2M is optional and needs a library that is not installed by default:

```bash
pnpm --filter @ai-orchestrator/api add @node-saml/node-saml@^5
```

L2M was tested with 5.2.0; use a 5.x release. Without it, `GET /api/auth/saml/metadata` reports `"ready": false` and sign-in answers that SAML is not configured. The package is not listed in `apps/api/package.json`, so add it before you build your own container image too.

## Step 2: read the IdP's metadata

Run Keycloak as in [the OIDC guide](/learn/operations/oidc-sso-with-keycloak#step-1-run-keycloak) and create the realm `example`. Keycloak publishes the realm's SAML metadata at:

```text
http://localhost:8180/realms/example/protocol/saml/descriptor
```

Three values come from it:

```bash
curl -s http://localhost:8180/realms/example/protocol/saml/descriptor > idp.xml
grep -o 'entityID="[^"]*"' idp.xml                            # the IdP entity ID
grep -o 'SingleSignOnService[^>]*Location="[^"]*"' idp.xml | head -1   # the sign-on URL
grep -o 'X509Certificate>[^<]*' idp.xml | head -1            # the signing certificate (base64)
```

For realm `example` they are `http://localhost:8180/realms/example`, `http://localhost:8180/realms/example/protocol/saml`, and a base64 certificate. Put the certificate on one line in `SAML_IDP_CERT`; the base64 body exactly as it appears in the metadata worked in our test.

## Step 3: register the SP in Keycloak

L2M does not serve SP metadata XML (its `/api/auth/saml/metadata` is a JSON status summary), so you register it by hand. With Keycloak's admin CLI (`kc` as defined in the OIDC guide):

```bash
SID=$(kc create clients -r example -i -s clientId=l2m-saml -s protocol=saml -s enabled=true \
  -s 'redirectUris=["https://l2m.example.com/api/auth/saml/callback"]' \
  -s 'attributes={
        "saml_assertion_consumer_url_post":"https://l2m.example.com/api/auth/saml/callback",
        "saml.server.signature":"true",
        "saml.assertion.signature":"true",
        "saml.client.signature":"false",
        "saml_name_id_format":"email",
        "saml_force_name_id_format":"true",
        "saml.signature.algorithm":"RSA_SHA256"}')
```

In the admin console these are, on the client: **Client ID** (the SP entity ID), **Assertion Consumer Service POST Binding URL**, **Sign documents**, **Sign assertions**, **Client signature required**, **Name ID format** and **Force name ID format**.

Why each one:

- **Client ID = `SAML_ISSUER`.** Keycloak uses it as the audience of the assertion, and L2M's library checks the assertion's `Audience` against that entity ID (its default).
- **Sign documents and Sign assertions, both on.** L2M uses the library's defaults, which require the response *and* the assertion inside it to be signed. With **Sign assertions** off, our first sign-in failed with `sso_error=saml_failed` and "Invalid signature" in the API log; turning it on fixed it. The specification is on the same side: in the browser profile, assertions "MUST be signed, if the HTTP POST binding is used".
- **Client signature required, off.** L2M sends unsigned `AuthnRequest`s.
- **Name ID format email, forced.** L2M asks for an email-format NameID and uses it as the account's identifier. A forced format avoids a username NameID slipping in.
- **Encrypt assertions, off.** L2M is not configured with a decryption key, so it cannot read encrypted assertions. Use HTTPS for the transport.

## Step 4: send email and groups as attributes

L2M reads the email from an attribute named `email` (or `mail`), falling back to the NameID, and groups from `SAML_GROUPS_ATTRIBUTE` (default `groups`). Add two mappers:

```bash
kc create clients/$SID/protocol-mappers/models -r example -s name=email -s protocol=saml \
  -s protocolMapper=saml-user-property-mapper \
  -s 'config={"user.attribute":"email","attribute.name":"email","attribute.nameformat":"Basic"}'

kc create clients/$SID/protocol-mappers/models -r example -s name=groups -s protocol=saml \
  -s protocolMapper=saml-group-membership-mapper \
  -s 'config={"attribute.name":"groups","attribute.nameformat":"Basic","single":"true","full.path":"false"}'
```

`single=true` puts all groups in one attribute with several values. `full.path=false` sends `l2m-builders` instead of `/l2m-builders`; group matching in L2M is exact. The assertion we received carried:

```xml
<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</saml:NameID>
...
<saml:Attribute Name="groups"><saml:AttributeValue>l2m-builders</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="email"><saml:AttributeValue>alice@example.com</saml:AttributeValue></saml:Attribute>
```

## Step 5: configure L2M

```bash
SAML_ENABLED=true
SAML_ENTRY_POINT=https://keycloak.example.com/realms/example/protocol/saml
SAML_ISSUER=l2m-saml
SAML_CALLBACK_URL=https://l2m.example.com/api/auth/saml/callback
SAML_IDP_CERT=MIICmzCCAYMCBgGa...      # one line, from the metadata
SAML_IDP_ISSUER=https://keycloak.example.com/realms/example
SAML_ALLOWED_GROUPS=l2m-builders
SAML_REQUIRE_IN_RESPONSE_TO=true
```

- **`SAML_IDP_ISSUER`** pins the IdP's entity ID: an assertion from another `Issuer` is refused. The certificate is pinned anyway; this adds a second check, and keeps account links tied to this IdP (L2M stores a SAML identity as `<IdP entity ID>#<NameID>`).
- **`SAML_ALLOWED_GROUPS`** limits who may sign in. SAML has no `email_verified`, so L2M trusts the email the configured IdP asserts; connect only an IdP whose users cannot choose an arbitrary address, and restrict sign-in by group.
- **`SAML_REQUIRE_IN_RESPONSE_TO`** is covered below.

Map the group to a role under **Settings → Access control → SSO Mappings**, or:

```http
POST /api/auth/sso/mappings
{ "provider": "saml", "groupName": "l2m-builders", "role": "builder" }
```

Start a sign-in at `GET /api/auth/saml/login`. In our run, Alice came back signed in with role `builder`, and the audit log had `user.login` with `"method": "saml"` and `"provisioned": true`.

## Signatures, clocks and replay

Three checks decide whether a response is accepted. Each has a typical failure.

**Signatures.** Both the response and the assertion must be signed with the key in `SAML_IDP_CERT`. When the IdP rotates its signing key, update `SAML_IDP_CERT` at the same time, or every sign-in fails with "Invalid signature" until you do.

**Time window.** An assertion carries `NotBefore` and `NotOnOrAfter`. L2M leaves the library's clock skew allowance at its default of 0 milliseconds, so the clocks of Keycloak and L2M must agree. A host a few seconds ahead of the IdP can see a fresh assertion as "not yet valid". Run NTP on both hosts.

**Replay.** The browser profile says the SP "MUST ensure that bearer assertions are not replayed, by maintaining the set of used ID values" for as long as the assertion is valid. L2M stores each accepted assertion's ID, with its IdP, in the database until its `NotOnOrAfter` plus five minutes (24 hours at most). We posted the same `SAMLResponse` a second time: the browser came back with `sso_error=saml_failed`, the log said "SAML assertion was already used", and the audit log recorded `reason: "replayed_assertion"`. Because the record is in the database, this also holds across several API instances.

## Unsolicited responses and login CSRF

Replay protection does not stop a fresh assertion from someone else. If the ACS URL accepts unsolicited responses, another user of the same IdP can make your browser post *their* new assertion, signing you in to *their* account. Whatever you then create lands in their account. This is login CSRF.

`SAML_REQUIRE_IN_RESPONSE_TO=true` closes it. L2M then puts the ID of each `AuthnRequest` in a short-lived cookie and accepts only a response whose `InResponseTo` matches it. The cost: IdP-initiated sign-in from the IdP's portal stops working, so users must start at L2M's login page; a sign-in started in a second tab replaces the first tab's. The cookie is `SameSite=None` and `Secure`, so this setting needs HTTPS outside `localhost`.

## MFA with SAML and Keycloak

SAML reports how the user signed in through `AuthnContextClassRef`. With `SSO_MFA=idp`, L2M accepts a SAML sign-in only when that value is in `SSO_MFA_SAML_AUTHN_CONTEXTS`, a list of multi-factor classes by default.

In our test, Keycloak 26.8.2 sent `urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified` even when Alice had just entered an OTP code. With Keycloak as a SAML IdP, `SSO_MFA=idp` would therefore refuse everyone. Two workable choices:

- Require OTP for every user in Keycloak's browser flow and leave `SSO_MFA` off, trusting the IdP's policy. Keep `MFA_REQUIRED_ROLES` empty (and `MFA_ENFORCE` unset) in that case: with `SSO_MFA` off, a role listed there still gets L2M's own TOTP step (or enrolment) after a SAML sign-in.
- `SSO_MFA=idp_or_local`, where users with L2M's own TOTP get a code step after the SAML sign-in. Users without local TOTP are refused, unless their role is in `MFA_REQUIRED_ROLES`, in which case they are asked to enrol, so set up TOTP for everyone first.

If you need L2M itself to verify the second factor from the IdP's answer, OIDC with the `amr` claim works with Keycloak; see [MFA on SSO with the amr claim](/learn/operations/oidc-sso-with-keycloak#mfa-on-sso-with-the-amr-claim). IdPs that send a multi-factor `AuthnContextClassRef` work with `idp` as is.

## Logout

L2M has no SAML single logout endpoint. Signing out of L2M ends its session only; the Keycloak session stays, so the next sign-in may not ask for a password. An earlier L2M session in the same browser is replaced, not revoked: the IdP's form post is cross-site, so it cannot see the old session cookie. Sign out before switching accounts if the old session must end at once.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| `"ready": false` in `/api/auth/saml/metadata` | `@node-saml/node-saml` not installed, or `SAML_ENTRY_POINT`, `SAML_ISSUER` or `SAML_CALLBACK_URL` missing |
| Keycloak shows an error page instead of its login form | No SAML client with that Client ID: it must equal `SAML_ISSUER` |
| `saml_failed`, "Invalid signature" | Assertion not signed (turn on **Sign assertions**), or `SAML_IDP_CERT` is not the current signing key |
| `saml_failed` right after a host change | Clocks apart: the assertion is not yet valid or already expired. Check NTP |
| `saml_failed`, "already used" | The same response posted twice (a reload of the post page, or a replay) |
| `saml_failed`, unsolicited | `SAML_REQUIRE_IN_RESPONSE_TO=true` and the sign-in started at the IdP, in another browser, or more than ten minutes ago |
| `saml_not_allowed` | Not in `SAML_ALLOWED_GROUPS`, or groups sent with a leading `/` |
| `sso_mfa_required` | `SSO_MFA=idp` and the IdP's `AuthnContextClassRef` is not a multi-factor class |

The API log has the detail; the audit log has a `user.login` failure with a short reason such as `replayed_assertion`, `unsolicited_response` or `not_allowed`.

## Try it in L2M

Install the library, run Keycloak and L2M locally with the settings above, and sign in at `/api/auth/saml/login`. The live demo has no sign-in. For the platform setup around it, see [Self-hosting an AI agent platform](/learn/operations/self-hosting-ai-agents).

## Further reading

- [SAML 2.0 Technical Overview](https://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html) (OASIS)
- [SAML 2.0 Profiles](https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf), section 4.1, Web Browser SSO, and [SAML 2.0 Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf) (OASIS)
- [node-saml README](https://github.com/node-saml/node-saml) (GitHub): signature and clock skew defaults
- [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html) (keycloak.org): SAML clients
- L2M docs: [SAML single sign-on](/security/auth-rbac#saml-single-sign-on), [Replay and unsolicited responses](/security/auth-rbac#replay-and-unsolicited-responses), [Linking SAML accounts](/security/auth-rbac#linking-saml-accounts), [MFA on SSO](/security/auth-rbac#mfa-on-sso), [Identity for AI platforms](/learn/operations/identity-for-ai-platforms)
