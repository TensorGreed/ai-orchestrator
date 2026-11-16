---
title: "Step-up authentication: a fresh check for risky acts"
term: "Step-up authentication"
topic: operations
definition: "Asking a signed-in user to prove who they are again, usually with a second factor, before a sensitive action such as creating an API key or changing a role."
description: "Step-up authentication asks a signed-in user for a fresh second factor before a sensitive action. Why sessions need it, and how it differs from MFA."
related: [mfa, sso, oidc, service-account, break-glass-access, rbac]
guide: [/learn/operations/identity-for-ai-platforms]
---

# Step-up authentication

**Asking a signed-in user to prove who they are again, usually with a second factor, before a sensitive action such as creating an API key or changing a role.**

A session is only as good as the moment it began. Someone signed in with <Term id="mfa">MFA</Term> this morning, then left the laptop open, or their session cookie was stolen by malware. Everything the session can do, the thief can do. Step-up narrows that: routine work goes on, but the few actions that would let an attacker stay in or widen their reach (minting keys, changing roles, editing secrets, turning MFA off) ask for a new proof first, if the last one is older than a few minutes.

NIST SP 800-63B-4 describes the idea in terms of assurance levels: an authentication process "may also provide step-up authentication to raise the session's AAL" (authenticator assurance level). On the API side, RFC 9470 standardises how a protected resource tells an OAuth client that the user's sign-in is not strong or recent enough: it answers with the error `insufficient_user_authentication` and can say which authentication context it wants (`acr_values`) or how recent the sign-in must be (`max_age`, in seconds).

## Example

An admin opens Settings and clicks **Create API key**. Their last code was entered three hours ago, and the deployment requires one within 15 minutes for this action. The server refuses with a "step-up required" answer, the app asks for a code from the authenticator, sends it, and retries the action. A stolen cookie alone can browse, but cannot mint a key.

## Common confusion

- **Step-up is not MFA at sign-in.** MFA proves who started the session; step-up asks again later, for one class of actions.
- **It is not session expiry.** A timeout ends the whole session; step-up keeps it and protects a few routes.
- **API keys cannot answer a code.** A system with step-up has to decide what a key may do on protected actions: refuse it, or allow only a narrowly scoped key meant for automation.

## In L2M

[Step-up](/security/auth-rbac#step-up-for-security-actions) is off unless `STEP_UP_MAX_AGE_MINUTES` is set. With it on, security-admin actions (users and roles, API keys and gateway clients, secrets, SSO mappings, notification and audit destinations, legal holds, retention and parts of data-subject requests) need an MFA check on the session within that many minutes; the studio asks for the code and retries. API keys are refused on those actions. The one exception is a [service-account key](/security/service-accounts#step-up-and-mfa) with an admin ceiling and no project list, on an account that is still an admin, and it too is refused on actions that target a person's account. Each step-up is audited as `mfa.step_up`.

## Further reading

- [NIST SP 800-63B-4, Digital Identity Guidelines: Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html) (nist.gov)
- [RFC 9470: OAuth 2.0 Step Up Authentication Challenge Protocol](https://www.rfc-editor.org/rfc/rfc9470) (IETF)
