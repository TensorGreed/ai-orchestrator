---
title: "SAML vs OIDC for single sign-on"
sidebarTitle: "SAML vs OIDC"
description: "Both log users in through an identity provider. Message formats, signing, mobile and API use, and which one a self-hosted AI platform should offer."
level: intermediate
about: saml
related: [saml, oidc, sso, mfa, pkce, oauth-2-1]
---

# SAML vs OIDC

<Term id="saml">SAML 2.0</Term> and <Term id="oidc">OpenID Connect</Term> (OIDC) do the same job: they let people sign in to an app with the account your identity provider already holds, which is <Term id="sso">single sign-on</Term>. They differ in how. SAML is an OASIS standard built on XML. The identity provider signs an XML assertion with XML Signature, and the browser carries it to the app in a form post. OIDC is "a simple identity layer on top of the OAuth 2.0 protocol". The browser carries only a short code, and the app swaps it for an ID token, a signed JSON Web Token, over a direct HTTPS call. For a browser sign-in either one is fine, and many organisations have years of SAML set-up. For mobile apps, command-line tools and anything that also calls APIs, OIDC fits better. A self-hosted AI platform that has to fit into many organisations should offer both.

## Side by side

| | SAML 2.0 | OpenID Connect |
| --- | --- | --- |
| Built on | Its own XML framework (OASIS) | OAuth 2.0 (OpenID Foundation) |
| What proves the sign-in | An XML assertion | An ID token, a JSON Web Token (JWT) |
| Signing | XML Signature; required on a response sent with the HTTP POST binding | JWS: "ID Tokens MUST be signed" |
| How it reaches the app | Usually through the browser: an auto-submitted form post to the app's callback | A code through the browser, then the token from a direct server-to-server request |
| Configuration | Metadata documents, or a pasted entity ID, URL and certificate | A discovery document at `/.well-known/openid-configuration` |
| Key rotation | A new certificate in each app, by hand or from refreshed metadata | The app re-reads the provider's published keys (`jwks_uri`) |
| Proof of the email | No standard "verified" flag; the app trusts the identity provider | `email_verified` claim |
| Proof of MFA | `AuthnContextClassRef` in the assertion | `amr` and `acr` claims in the ID token |
| Native, mobile and CLI apps | Awkward: the flow assumes a browser | Supported, with PKCE for public clients |
| Calling APIs afterwards | Not covered by browser SSO | OAuth 2.0 access tokens come from the same flow |
| Logout | A Single Logout protocol | Separate specifications, such as RP-Initiated Logout 1.0 |

<figure>
<svg viewBox="0 0 640 270" role="img" aria-labelledby="sso-fig-title sso-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="sso-fig-title">The SAML and OIDC sign-in flows</title>
  <desc id="sso-fig-desc">Two rows. In SAML, the identity provider posts a signed XML assertion through the browser to the app. In OIDC, the identity provider sends only a code through the browser, and the app exchanges the code for a signed ID token directly with the identity provider.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <text x="20" y="22" font-weight="600">SAML 2.0 (Web Browser SSO, HTTP POST binding)</text>
    <rect x="20" y="40" width="150" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="95" y="67" text-anchor="middle">Identity provider</text>
    <rect x="245" y="40" width="150" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="320" y="67" text-anchor="middle">Browser</text>
    <rect x="470" y="40" width="150" height="44" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="545" y="67" text-anchor="middle">App</text>
    <path d="M170 62 L245 62" stroke="currentColor" fill="none"/>
    <path d="M395 62 L470 62" stroke="currentColor" fill="none"/>
    <text x="320" y="110" text-anchor="middle" font-size="12">the whole signed XML assertion travels through the browser</text>
    <text x="20" y="150" font-weight="600">OpenID Connect (Authorization Code flow)</text>
    <rect x="20" y="168" width="150" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="95" y="195" text-anchor="middle">Identity provider</text>
    <rect x="245" y="168" width="150" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="320" y="195" text-anchor="middle">Browser</text>
    <rect x="470" y="168" width="150" height="44" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="545" y="195" text-anchor="middle">App</text>
    <path d="M170 190 L245 190" stroke="currentColor" fill="none"/>
    <path d="M395 190 L470 190" stroke="currentColor" fill="none"/>
    <text x="320" y="182" text-anchor="middle" font-size="12">code</text>
    <path d="M545 212 L545 245 L95 245 L95 212" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2" fill="none" stroke-dasharray="5 3"/>
    <text x="320" y="262" text-anchor="middle" font-size="12">app swaps the code for a signed ID token, server to server</text>
  </g>
</svg>
<figcaption>In SAML the proof itself goes through the browser. In OIDC the browser carries a short-lived code, and the token comes back on a direct call.</figcaption>
</figure>

## How a SAML sign-in works

The SAML Technical Overview calls SAML a framework "for describing and exchanging security information between on-line business partners". It has four parts: assertions (statements about a user), protocols (request and response messages), bindings (how messages travel, such as HTTP Redirect, HTTP POST and HTTP Artifact) and profiles (combinations for one use case). The profile used for sign-in is Web Browser SSO.

In an app-initiated sign-in, the app redirects the browser to the identity provider with an authentication request. The person signs in there. The identity provider returns an HTML form that the browser posts to the app's callback. It holds a SAML response with the assertion, which names the user (the `NameID`) and carries attributes such as email and groups. The overview says that with the HTTP POST binding "it is mandated that the response message be digitally signed using XML Signature". The app checks that signature against the identity provider's certificate, which an admin has set up in advance.

SAML also allows identity-provider-initiated sign-in. The person clicks the app's tile in the provider's portal, and the provider posts an assertion nobody asked for. It is convenient. It also means the app cannot tie the response to a sign-in it started, which opens the door to login cross-site request forgery: an attacker's page posts the attacker's own valid assertion, and your browser ends up signed in to their account.

## How an OIDC sign-in works

With the Authorization Code flow, the app redirects the browser to the identity provider with its client id, the scopes it wants (at least `openid`), a `state` value and a `nonce`. After sign-in, the provider redirects back with a short-lived code. The app sends that code, from its server, to the provider's token endpoint and receives the ID token. The core specification defines it as "a security token that contains Claims about the Authentication of an End-User", represented as a JWT and signed with JWS.

The app then validates the token. The issuer must match exactly, the audience must contain the app's client id, the token must not be expired, and the `nonce` must equal the one the app sent. The signature is checked against keys the app fetches from the provider's `jwks_uri`, which Discovery 1.0 describes as containing "the signing key(s) the RP uses to validate signatures from the OP". When the provider rotates keys, the app picks up the new ones without anyone pasting a certificate.

For apps that cannot keep a secret, such as single-page apps, mobile apps and command-line tools, OIDC adds PKCE. RFC 7636 says public clients using the code grant "are susceptible to the authorization code interception attack" and defines Proof Key for Code Exchange to stop it. Because OIDC is OAuth 2.0 underneath, the same sign-in can also return an access token that lets the app call APIs on the user's behalf. SAML browser SSO has no equivalent.

## Where each one goes wrong

Both are safe when implemented well. They fail in different places.

**SAML's risks sit in XML.** Signature checking must cover the assertion the app actually reads, not a different element elsewhere in the document. Each assertion should be accepted only once, so a captured response cannot be replayed. Use a maintained library rather than a hand-written XML parser. And there is no `email_verified`: the app trusts whatever email the identity provider asserts, so only connect a provider whose users cannot choose an arbitrary address.

**OIDC's risks sit in token validation.** Refuse unsigned tokens (`alg: none`) and symmetric algorithms an attacker could sign with the provider's public key. Check `iss`, `aud`, `nonce` and expiry on every token. Check `state` on every callback. Do not link an existing account by an email the provider has not verified; the specification says a true `email_verified` means "the OP took affirmative steps to ensure that this e-mail address was controlled by the End-User".

Both need the same policy decisions on top: who may sign in at all, how groups become roles, and whether the sign-in must include MFA. Those are covered in [identity for AI platforms](/learn/operations/identity-for-ai-platforms).

## When to use which

- **Your identity provider and your security team already run SAML for most apps:** use SAML. Onboarding is a familiar form for them: entity ID, callback URL, certificate.
- **You start fresh, or the provider supports both equally:** prefer OIDC. Discovery and key rotation are automatic, and the tokens are JSON.
- **Users sign in from a command-line tool, a desktop app or a mobile app:** use OIDC with PKCE.
- **The app also needs to call APIs as the user:** use OIDC; the access token comes from the same flow.
- **You need logout to reach every app at once:** check what your provider actually implements. SAML defines Single Logout; for OIDC it is a separate specification. Either way, short app sessions are the reliable fallback.

## How they combine

An app can offer both and let each organisation pick. A few rules keep that safe:

- **One identity per protocol and issuer.** Store an OIDC identity as issuer plus `sub` and a SAML identity as the provider's entity ID plus `NameID`. A `sub` is unique only within one issuer, and a `NameID` only within one SAML provider.
- **The same policy for both.** Apply the same allow-lists, group mappings and MFA rule to each, so the choice of protocol does not change who gets in or what role they get.
- **Neither provisions or removes accounts by itself.** Both create accounts at sign-in at most. For removing leavers, see [SSO vs SCIM](/learn/operations/sso-vs-scim).

## In L2M

L2M, a self-hosted workflow builder and agent runtime, supports both, and both are off by default. With neither set, people sign in with email and password ([Authentication and RBAC](/security/auth-rbac)).

- **OIDC** (`OIDC_ENABLED=true`) uses the Authorization Code flow with PKCE (S256), `state` and `nonce`. The ID token must be signed with RS\*, PS\* or ES\*; `none` and HS\* are refused. `iss`, `aud`, `azp`, `exp`, `iat` and `nonce` are checked. Discovery and the provider's keys are cached for an hour, and a token signed with an unknown key id refetches them, so key rotation needs no restart. An unverified email never links to an existing account unless you set `OIDC_REQUIRE_EMAIL_VERIFIED=false` ([OIDC single sign-on](/security/auth-rbac#oidc-single-sign-on)).
- **SAML 2.0** (`SAML_ENABLED=true`) needs the optional `@node-saml/node-saml` package, a 5.x release, added to the API; without it the SAML routes answer that SAML is not configured. The response arrives only by HTTP POST. Each assertion is accepted once, and with `SAML_REQUIRE_IN_RESPONSE_TO=true` only answers to a sign-in started from L2M in the same browser are accepted, which closes the login CSRF gap at the cost of portal sign-in. The configured provider is trusted for the email it asserts, because its certificate is pinned in `SAML_IDP_CERT` ([SAML single sign-on](/security/auth-rbac#saml-single-sign-on)).
- **Shared rules.** Email-domain and group allow-lists, group-to-role mappings and the `SSO_MFA` setting work for both. MFA is read from `amr` or `acr` in the ID token, or from the assertion's `AuthnContextClassRef` ([MFA on SSO](/security/auth-rbac#mfa-on-sso)).
- **Logout** ends the L2M session only, not the session at the identity provider.

LDAP sign-in against a directory is also available, as an API route.

## Further reading

- [SAML V2.0 Technical Overview](https://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html) (OASIS): assertions, bindings, profiles, Web Browser SSO
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) (OpenID Foundation): ID token, flows, `email_verified`
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html) (OpenID Foundation): the configuration document and `jwks_uri`
- [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html) (OpenID Foundation)
- [RFC 7636: Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636) (IETF)
- L2M docs: [Authentication and RBAC](/security/auth-rbac)
