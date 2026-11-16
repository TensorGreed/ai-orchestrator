---
title: "Legal hold: keeping data from deletion"
term: "Legal hold"
topic: operations
definition: "An instruction to keep certain data from being deleted, whatever its age, because it may be needed for a legal matter."
description: "A legal hold stops chosen data from being deleted, by retention or by hand, while a legal matter needs it. What it covers and how it meets erasure."
related: [data-retention, data-subject-request, right-to-erasure, audit-log, subject-reference]
guide: [/learn/operations/ai-data-retention-and-erasure]
---

# Legal hold

**An instruction to keep certain data from being deleted, whatever its age, because it may be needed for a legal matter.**

Most systems delete data on purpose: <Term id="data-retention">retention</Term> purges old runs, people delete workflows, and privacy law lets people ask for erasure. A legal hold, also called a litigation hold, is the exception. When a dispute, an investigation or a regulator's request is expected, the data that may matter is set aside and kept until someone releases the hold.

The duty comes from law, not from the software. In the United States, Federal Rule of Civil Procedure 37(e) lets a court act when electronically stored information "that should have been preserved in the anticipation or conduct of litigation is lost" because a party did not take reasonable steps to keep it, and it cannot be restored or replaced. The rule's 2006 committee note (on what was then Rule 37(f)) describes "intervention in the routine operation of an information system" as one aspect of what is "often called a 'litigation hold.'" Under the GDPR, the right to erasure does not apply to the extent processing is needed "for the establishment, exercise or defence of legal claims" (Article 17(3)(e)).

A useful hold has a clear scope (a project, a workflow, a list of runs, one person's records), a named reason, an owner, and a release that is recorded too. A hold nobody releases quietly becomes keeping data forever.

## Example

A customer disputes what a support agent promised them. Legal asks for everything about that customer's conversations. An admin places a hold on the support workflow, with the matter reference. That night's retention purge skips the workflow's runs, a builder's attempt to delete the workflow is refused, and a week later the customer's erasure request deletes everything else about them but leaves the held rows, saying so. When the matter closes, the hold is released with a reason, and the next purge removes what has aged out.

## Common confusion

- **A hold is not a backup.** It keeps data in place inside the application. Someone with direct database access can still delete it.
- **A hold is not access control.** It stops deletion, not reading.
- **Whether a hold, or the legal-claims exception, applies is a legal decision.** The system only enforces it.

## In L2M

[Legal holds](/operations/legal-hold) are optional. Admins, and people with a deployment-wide role that grants `legal_hold:manage`, place them on a project, a workflow, a list of runs, or the rows a data-subject lookup finds for one value (admins only). Held data is left out of retention purges; deletes and moves of held items are refused with `409 legal_hold`, and a [data-subject deletion](/security/data-subject-requests#deleting-a-persons-data) defers held rows until release. Placing and releasing are audited, and need a recent MFA check when step-up is on. The blog post [Retention, legal holds and data-subject requests](/blog/retention-legal-holds-and-subject-requests) walks through the whole set.

## Further reading

- [Federal Rules of Civil Procedure, Rule 37 and committee notes](https://www.law.cornell.edu/rules/frcp/rule_37) (Cornell LII)
- [GDPR Article 17, right to erasure](https://gdpr-info.eu/art-17-gdpr/) (gdpr-info.eu)
