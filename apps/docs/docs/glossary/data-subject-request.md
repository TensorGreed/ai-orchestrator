---
title: "Data-subject request (DSR): access and erasure"
term: "Data-subject request"
topic: operations
definition: "A person's request to an organization about their own personal data, such as a copy of it or its deletion, under privacy laws like the GDPR."
description: "A data-subject request asks an organization for a copy of a person's data, or its deletion. The GDPR deadlines, and how AI apps find the data."
related: [right-to-erasure, subject-reference, legal-hold, data-retention, pii]
guide: [/learn/operations/ai-data-retention-and-erasure]
---

# Data-subject request

**A person's request to an organization about their own personal data, such as a copy of it or its deletion, under privacy laws like the GDPR.**

The "data subject" is the person the data is about. In the GDPR, the best-known requests are access (Article 15: confirmation of whether their data is processed, and "a copy of the personal data undergoing processing") and erasure (Article 17, the <Term id="right-to-erasure">right to erasure</Term>). Other privacy laws have similar rights under other names. DSR and DSAR (data-subject access request) are common short forms.

Article 12 sets the ground rules for requests under Articles 15 to 22: answer "without undue delay and in any event within one month of receipt", extendable by two further months for complex or numerous requests; free of charge as a rule; and, for Articles 15 to 21, if there is reasonable doubt about who is asking, the organization may ask for the information needed to confirm their identity.

For an AI application, the hard part is finding the data. A person's details end up in run inputs, model answers, tool results, agent memory, approval requests, test fixtures and logs. Searching every row for an email is slow and misses runs that held only a customer id. Recording at write time which person a run was about (a <Term id="subject-reference">subject reference</Term>) makes the later search cheap.

## Example

A customer emails: "Send me everything you hold about me, then delete it." The privacy team confirms it is really them, then searches by their email and customer id. The export finds 14 agent runs and one memory session. Before sending it, they check it: one support run also names a second customer, whose details must not go out with it (Article 15(4) says the copy must not adversely affect others' rights). Then they run the deletion. Rows under a <Term id="legal-hold">legal hold</Term> stay, and the reply says so.

## Common confusion

- **Access and erasure are different requests** with different exceptions. An access request never deletes anything.
- **Deleting the account is not erasure.** The person's data also sits in runs, memory, caches and backups.
- **A request is not proof of identity.** Handing one person's data to someone else is a breach in its own right.

## In L2M

[Data-subject requests](/security/data-subject-requests) are optional and off until used. An admin, or someone with a deployment-wide role granting `data_subject:manage`, enters the person's value; L2M follows optional per-workflow subject references (stored as keyed hashes) and can also search stored data. It builds a zip export that downloads once, or, after a preview is confirmed, [deletes what it found](/security/data-subject-requests#deleting-a-persons-data), skipping rows a legal hold keeps. Each request has a due date (`SUBJECT_REQUEST_DUE_DAYS`, 30 by default) and an overdue notice. The [Settings](/security/data-subject-requests#settings) table lists the limits.

## Further reading

- [GDPR Article 12, transparent information and modalities](https://gdpr-info.eu/art-12-gdpr/) (gdpr-info.eu)
- [GDPR Article 15, right of access](https://gdpr-info.eu/art-15-gdpr/) (gdpr-info.eu)
- [GDPR Article 17, right to erasure](https://gdpr-info.eu/art-17-gdpr/) (gdpr-info.eu)
