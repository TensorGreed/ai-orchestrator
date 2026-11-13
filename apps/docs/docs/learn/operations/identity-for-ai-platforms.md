---
title: "Identity for AI platforms: SSO, MFA, roles and keys"
sidebarTitle: "Identity for AI platforms"
description: "Who may build, run, approve and call agents: single sign-on with OIDC or SAML, MFA per role, project roles, service accounts and scoped API keys."
level: intermediate
about: sso
related: [sso, oidc, saml, mfa, rbac, service-account]
---

# Identity for AI platforms

Identity on an AI platform decides who may build agents, run them, approve what they do and call them from outside. People should sign in through your organisation's identity provider with single sign-on, with a second factor for the roles that can change the most. Automation should use service accounts whose API keys are limited by role, project and expiry. Outside agents and <Term id="mcp-client">MCP clients</Term> should each get their own token, limited to the tools they need. Roles and projects then decide what each identity may touch.

## People, automation and agents are different identities

An AI platform has three kinds of caller, and each needs a different kind of credential:

| Caller | Example | Credential |
|---|---|---|
| A person | A builder editing a workflow, a lead approving a refund | A browser session after SSO or password sign-in, with MFA |
| Automation | A CI job that replays tests and publishes a version | An API key owned by a service account |
| An agent or MCP client | A coding assistant in an editor calling your tools | A client token for one gateway endpoint |

Mixing them causes most of the trouble. A CI pipeline that uses a person's API key stops when that person leaves, and acts with all of their rights in the meantime. An editor plug-in that uses an admin's key can do whatever that admin can. Giving each caller its own identity keeps the audit trail readable and lets you revoke one without breaking the others.

## Single sign-on: OIDC, SAML and LDAP

<Term id="sso">Single sign-on</Term> lets people use the accounts your organisation already manages, so leavers lose access when their directory account is disabled. Three protocols are common.

**OpenID Connect.** The specification calls <Term id="oidc">OIDC</Term> "a simple identity layer on top of the OAuth 2.0 protocol". After sign-in, the identity provider returns an ID token, "a security token that contains Claims about the Authentication of an End-User". The app must check that token: its issuer must match exactly, its audience must contain the app's client id, and when the app sent a nonce, the token must carry the same one.

**SAML 2.0.** <Term id="saml">SAML</Term> "defines an XML-based framework for describing and exchanging security information". The identity provider sends an assertion, which carries "statements about a principal that an asserting party claims to be true", usually through the browser in a form post.

**LDAP.** Older directories are often reached over LDAP: the app checks the person's password against the directory and reads their groups.

Whichever you use, decide three things up front:

- **Who may sign in at all.** An identity provider shared with contractors, guests or other tenants will happily authenticate people you never meant to admit. Restrict by email domain or group, at the provider or in the app.
- **How accounts are matched.** Matching an SSO login to an existing account by email is only safe when the provider has verified that email. Otherwise anyone who can set an address at the provider can take over the matching account.
- **How groups become roles.** Map directory groups to roles, so access follows the directory instead of manual edits.

## MFA and step-up

<Term id="mfa">Multi-factor authentication</Term> adds a second proof, such as a code from an authenticator app, so a stolen password alone is not enough. Two refinements matter on an agent platform.

**MFA per role.** Requiring MFA for everyone is simplest, but you may start with the roles that can do the most damage: admins and builders, who can change workflows, secrets and keys. A user in such a role who has not set up MFA can be limited to setting it up rather than locked out.

**MFA with SSO.** If people sign in through an identity provider, the second factor usually happens there. The app then needs to know it happened. OIDC defines claims for this: `amr`, a "JSON array of strings that are identifiers for authentication methods used in the authentication", and `acr`, an authentication context class reference. SAML carries an authentication context in the assertion. An app can require one of these, or fall back to its own one-time code.

**Step-up.** Some actions deserve a fresh check even inside a valid session: creating an API key, changing a role, editing a secret, minting a gateway token. Step-up asks for a new code when the last one is older than a few minutes. A stolen session cookie then cannot mint new credentials.

## Roles and projects

<Term id="rbac">Role-based access control</Term> gives permissions to roles and roles to people. A typical split for an agent platform:

- **Viewer**: reads workflows and runs.
- **Operator**: what a viewer can do, plus operating tasks such as deciding approvals, without editing.
- **Builder**: builds, edits and runs workflows, and manages secrets.
- **Admin**: everything, including users, keys, settings and audit.

Global roles alone are too coarse once several teams share a platform. Projects narrow them: a membership gives a person a role inside one project, and strict isolation means people see only the projects they belong to. The payments team's secrets and MCP servers then stay out of reach of the marketing team's agents.

## Service accounts and key scopes

A <Term id="service-account">service account</Term> is an identity for a program. It cannot sign in, it is not tied to one employee, and its keys are made by an admin. Good practice for its API keys:

- **A role ceiling.** A key never has more than its ceiling, and never more than its owner has right now. A deploy key needs builder, not admin.
- **A project list.** The key reaches only the named projects; everything else reads as missing.
- **An expiry, and rotation with overlap.** A new key, with the old one working for a short grace window, lets callers switch without an outage.
- **No approvals.** A program should never be the one who approves an agent's risky step. Keep approvals for people.

Following <Term id="least-privilege">least privilege</Term> here costs little and limits what a leaked key can do.

## MCP clients and gateway tokens

When outside agents call your tools through an <Term id="mcp-gateway">MCP gateway</Term>, each client should get its own token, valid only for the <Term id="toolset">toolsets</Term> it needs. Tie each token to a role, so <Term id="mcp-tool-policy">tool policy</Term> can treat a read-only assistant differently from a trusted internal agent, and let the token expire.

Do not reuse the caller's token further down. The MCP authorization specification says a server "MUST NOT pass through the token it received from the MCP client" to upstream APIs, and must only accept tokens issued for itself. That anti-pattern is called <Term id="token-passthrough">token passthrough</Term>. A gateway should hold its own credentials for the servers behind it.

## Break-glass

Single sign-on and MFA add ways to be locked out: the identity provider is down, or the only admin lost their authenticator. A break-glass procedure is the planned way back in. Make it rare and loud: something only a person with server access can start, valid once, for a short session, with every request recorded and an alert sent. Afterwards, review what the session changed.

## Sessions and limits

Sessions are identities too, and a long-lived one is a standing credential. Useful limits:

- an idle timeout, shorter for admins;
- an absolute lifetime, after which the person signs in again;
- a cap on sessions per user, so an old device's session ends;
- a list of signed-in sessions, so people and admins can end one.

Network allowlists add a layer: the admin interface, the API and the MCP gateway can each accept only their expected address ranges.

## Identity in L2M

L2M, a self-hosted workflow builder and agent runtime, implements these pieces on your own deployment. Each one is optional: with no setting, people sign in with email and password.

- **SSO.** OIDC (`OIDC_ENABLED`), with the Authorization Code flow, PKCE and checks on `iss`, `aud`, `nonce` and expiry; SAML 2.0 (`SAML_ENABLED`); and LDAP (`LDAP_ENABLED`). Allow-lists by email domain or group, verified-email linking, and group-to-role mappings ([OIDC single sign-on](/security/auth-rbac#oidc-single-sign-on)).
- **MFA.** TOTP with backup codes. `MFA_REQUIRED_ROLES=admin,builder` requires it per role, and limits an unenrolled user to setting it up. `SSO_MFA=idp` requires the identity provider to assert MFA (through `amr`, `acr` or the SAML authentication context); `idp_or_local` also accepts L2M's own code.
- **Step-up.** `STEP_UP_MAX_AGE_MINUTES` asks for a fresh code before actions such as creating keys, changing roles, editing secrets and creating gateway clients.
- **Roles and projects.** Global roles `admin`, `builder`, `operator` and `viewer` (an operator can decide approvals a gate allows them to and queue runs, but not edit or start runs from the editor); project roles project admin, editor and viewer, plus custom roles; `PROJECT_ISOLATION=strict` for teams that must not see each other's work.
- **Service accounts.** Admin-managed, no sign-in, never approvers. Keys look like `ao_…` and can carry a role ceiling, a project list (which caps them at builder) and an expiry; `SERVICE_ACCOUNT_KEY_MAX_AGE_DAYS` caps their age, and rotation keeps the old key for a grace window ([key scopes](/security/service-accounts#key-scopes)).
- **Gateway clients.** Each MCP gateway client has its own `l2m_mcp_…` token, its toolsets, a role capped at its creator's current role, and an expiry. Only a hash of the token is stored ([clients](/product/mcp-gateway#clients)). Optionally, pin a client to address ranges or a client certificate ([network controls](/security/network-controls)).
- **Break-glass.** `admin:break-glass` on the server host prints a one-time link for a one-hour admin session; every request in it is audited, and an alert goes to the notification channels that take it.
- **Sessions.** `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS` and `SESSION_MAX_PER_USER`, each with per-role overrides.

To try a gateway client, follow the [workflow as an MCP tool recipe](/recipes/workflow-as-mcp-tool): it creates a client for one toolset and calls the tool with its token.

See also: [Least privilege for AI agents](/learn/security/least-privilege-for-agents), for limiting what each identity's agents can do once signed in.

## Further reading

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) (OpenID Foundation): ID tokens, `amr` and `acr`, ID token validation
- [SAML V2.0 Technical Overview](https://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html) (OASIS): assertions and the Web Browser SSO profile
- [MCP specification 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (modelcontextprotocol.io): audience checks and no token passthrough
- L2M docs: [Authentication and RBAC](/security/auth-rbac), [Service accounts and API keys](/security/service-accounts)
