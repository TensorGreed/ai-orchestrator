---
title: "OpenID Connect (OIDC): sign-in on top of OAuth"
term: "OIDC"
topic: operations
definition: "OpenID Connect: an identity layer on top of OAuth 2.0 that adds a signed ID token, so an application can learn who signed in at an identity provider, not just get access to an API."
description: "OIDC adds a signed ID token and user info to OAuth 2.0 so apps can sign people in through an identity provider. Claims, flows and common mistakes."
related: [sso, saml, mfa, pkce, scim, step-up-authentication]
guide: [/learn/operations/identity-for-ai-platforms]
---

# OIDC

**OpenID Connect: an identity layer on top of OAuth 2.0 that adds a signed ID token, so an application can learn who signed in at an identity provider, not just get access to an API.**

OAuth answers "may this app call that API?". It says nothing reliable about who the user is. OpenID Connect (OIDC) fills that gap. The application (the relying party) asks for the `openid` scope; the identity provider (the OpenID provider) signs the person in and returns an **ID token**, a signed JWT about that sign-in, next to the usual access token.

The ID token always carries:

- `iss`: the issuer, which must exactly match the provider the app expects;
- `sub`: an identifier that is "locally unique and never reassigned" within that issuer;
- `aud`: the audience, which must include the app's client id;
- `exp` and `iat`: when it expires and when it was issued.

A `nonce` from the request comes back in the token and ties it to that login. Profile claims such as `email`, `email_verified` and `name`, and provider-specific ones such as groups, come from the token or the userinfo endpoint.

The flow is picked by `response_type`: `code` for the authorization code flow, the one a server-side app should use (with <Term id="pkce">PKCE</Term>), and the implicit and hybrid flows, which return tokens straight from the authorization endpoint through the browser.

## Example

```json
{ "iss": "https://idp.example.com/realms/acme", "sub": "4f1c2a9e",
  "aud": "l2m", "exp": 1763300000, "iat": 1763299700, "nonce": "n-0S6_WzA2Mj",
  "email": "ana@example.com", "email_verified": true, "groups": ["platform-admins"] }
```

## Common confusion

- **The access token is not an identity proof.** Sign-in rests on a validated ID token: signature, `iss`, `aud`, expiry and `nonce`. Accepting `alg: none` lets anyone forge a token; skipping the audience check lets a token minted for another app sign someone in here.
- **Email is not a user id.** OIDC Core says only `iss` and `sub` together are a stable, unique identifier; `email` and the other profile claims "MUST NOT be used as unique identifiers". Linking accounts by an unverified email is a known takeover path.
- **OIDC is not provisioning.** It signs people in; creating and removing accounts ahead of time is <Term id="scim">SCIM</Term>'s job. And it is not <Term id="saml">SAML</Term>, which does the same job with signed XML.

## In L2M

[OIDC single sign-on](/security/auth-rbac#oidc-single-sign-on) is opt-in (`OIDC_ENABLED`). L2M uses the code flow with PKCE (S256), `state` and `nonce`. It accepts only asymmetrically signed ID tokens, and checks `iss`, `aud`, `azp`, `exp`, `iat` and `nonce`. It stores each identity under issuer plus `sub`, and links by email only when the email is verified, unless `OIDC_REQUIRE_EMAIL_VERIFIED=false` ([Linking accounts](/security/auth-rbac#linking-accounts)). Group claims can map to roles ([group-to-role mappings](/security/auth-rbac#group-to-role-mappings)). For a worked setup, see [OIDC sign-in with Keycloak](/learn/operations/oidc-sso-with-keycloak); for how sign-in differs from provisioning, see [SSO vs SCIM](/learn/operations/sso-vs-scim).

## Further reading

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) (openid.net)
- [RFC 7636: Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636.html) (IETF)
