---
title: "Service account: an identity for automation"
term: "Service account"
topic: operations
definition: "An account for a program rather than a person, such as a CI job, with its own keys and its own limited permissions."
description: "A service account is an identity for a CI job or script: no password, its own keys and a limited role. How it differs from a shared admin key."
related: [rbac, least-privilege, mfa, step-up-authentication, audit-log, sso]
guide: [/learn/operations/identity-for-ai-platforms]
---

# Service account

**An account for a program rather than a person, such as a CI job, with its own keys and its own limited permissions.**

Automation needs credentials too: a pipeline that publishes workflows, a script that starts runs every night, another service that reads results. The easy answer is to paste an admin's personal key into the pipeline. That key then does everything the admin can do, it stops working when the admin leaves, and the audit log says the admin did it.

A service account fixes all three. It is an identity of its own, so it gets only the role the job needs (<Term id="least-privilege">least privilege</Term>). It does not depend on any one employee. And every action it takes is recorded under its own name. NIST SP 800-53 lists "service" among the kinds of system accounts an organization manages, next to individual, shared, emergency and temporary ones.

Because no person stands behind it, a service account usually cannot sign in through a login page, cannot pass a second factor, and should never be the one who approves a risky step.

## Example

A release pipeline needs to publish workflows in one project. An admin creates a service account `ci-deployer` with the builder role, then gives it one key limited to that project, with an expiry of 90 days. When the key leaks in a build log, it reaches one project at builder level, and the admin revokes or rotates it without touching anyone's personal account.

## Common confusion

- **A service account is not a shared account.** A shared account is one login several people use, which hides who did what. A service account is used by one program.
- **It is not the same as an API key.** The key is the credential; the account is the identity that holds roles and owns the keys. One account can hold several keys with different limits.
- **It is not an MCP client token.** Outside agents that call tools through a gateway get their own client tokens, scoped to toolsets.

## In L2M

[Service accounts](/security/service-accounts) are optional and managed by admins under Settings. One has a global role and project memberships, like a person, but cannot sign in by password, SSO, LDAP or invite: only its API keys authenticate it. It never decides approvals. Its keys can carry a role ceiling and a project list ([key scopes](/security/service-accounts#key-scopes)), are made only by an admin, and can be rotated with a grace window. With [step-up](/security/service-accounts#step-up-and-mfa) on, an admin-ceiling service-account key with no project list is the way automation performs security-admin actions, except those that target a person's account.

## Further reading

- [NIST SP 800-53 Rev. 5, control AC-2 Account Management](https://doi.org/10.6028/NIST.SP.800-53r5) (nist.gov)
