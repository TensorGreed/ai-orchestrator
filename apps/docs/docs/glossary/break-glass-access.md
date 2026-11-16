---
title: "Break-glass access: the emergency way back in"
term: "Break-glass access"
topic: operations
definition: "A planned, rarely used way to get admin access in an emergency, such as an SSO outage or a lost authenticator, that is short-lived, recorded in full and raises an alert."
description: "Break-glass access is a planned emergency way in when normal sign-in fails: short-lived, audited, alerting. How it differs from a shared admin password."
related: [mfa, sso, step-up-authentication, audit-log, rbac, least-privilege]
guide: [/learn/operations/identity-for-ai-platforms]
---

# Break-glass access

**A planned, rarely used way to get admin access in an emergency, such as an SSO outage or a lost authenticator, that is short-lived, recorded in full and raises an alert.**

The name borrows from a fire alarm behind glass: anyone may break it in an emergency, and everyone knows it happened. Stronger sign-in brings new ways to be locked out. The identity provider is down, the only admin's phone is lost, a network allowlist was set wrong. Without a plan, people improvise in the middle of an outage, often by editing the database by hand or by keeping a shared admin password that nobody rotates.

A break-glass procedure decides in advance how the way back in works. Good ones share a few traits:

- **Hard to start.** Only someone with privileged access to the host, or a sealed credential held offline, can begin it.
- **Short-lived.** It grants a session or account that ends on its own. NIST SP 800-53 (control AC-2(2)) asks for temporary and emergency accounts to be removed or disabled automatically after a set time, "rather than at the convenience of the system administrator".
- **Loud.** Every request in it is recorded, and alerts go out when it is issued, used and ended.
- **Reviewed.** Afterwards someone checks what changed, undoes what should not stay, and writes down why it was needed.

NIST also notes that emergency account activation "may bypass normal account authorization processes", which is exactly why the logging and the time limit matter.

## Example

A company's SSO provider has an outage, and the policy requires SSO for every admin. An on-call engineer with shell access to the server runs the break-glass command for the admin account. It prints a one-time link valid for 15 minutes and alerts the security channel. The engineer signs in, fixes the login settings, and signs out. The next day the security team reads the session's request log and closes the incident.

## Common confusion

- **A break-glass account is not a spare admin login.** A standing admin password kept "just in case" is always usable and rarely watched. Break-glass access exists only while it is in use.
- **It does not skip every control.** It removes the obstacle that locked people out (an MFA requirement, SSO), not the record of what they did.

## In L2M

[Break-glass sign-in](/security/auth-rbac#break-glass-sign-in) is a command run on the API host (`admin:break-glass`) that prints a one-time link for a human admin. The link is valid for 5 to 60 minutes (15 by default) and gives a one-hour session that is never renewed. The session skips per-role MFA, step-up and session limits, so an admin can repair them; the network allowlists still apply. Every request in it is audited, even with the audit log off, the studio shows a red banner, and the `auth.break_glass_used` notification fires when the link is issued, used and ended. Nothing exists until someone runs the command. [Network break-glass](/security/network-controls#break-glass) is a separate setting for a wrong allowlist.

## Further reading

- [NIST SP 800-53 Rev. 5, control AC-2 Account Management and enhancement AC-2(2)](https://doi.org/10.6028/NIST.SP.800-53r5) (nist.gov)
