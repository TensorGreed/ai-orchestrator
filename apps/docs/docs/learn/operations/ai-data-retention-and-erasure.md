---
title: "AI data retention, erasure requests and legal holds"
sidebarTitle: "Data retention and erasure"
description: "Where an AI app keeps personal data, how retention purges it, how to answer access and erasure requests, and how legal holds stop deletion."
level: intermediate
about: data-retention
related: [data-retention, data-subject-request, right-to-erasure, legal-hold, subject-reference, signed-run-manifest]
---

# AI data retention, erasure requests and legal holds

An AI agent platform keeps personal data in many more places than its chat history: run records, tool-call logs, <Term id="agent-memory">agent memory</Term>, cached tool results, test recordings, audit records, traces and backups. Managing it takes four things. A data map that lists every store. A retention window for each store, enforced by a purge. A way to find, export and delete one person's data on request. And a <Term id="legal-hold">legal hold</Term> that stops deletion when data must be kept for a dispute. Some copies cannot be deleted on request at all, such as backups already written and signed audit records, so the honest answer to an erasure request says what was deleted and what was not.

This page explains the engineering. It is not legal advice: ask your lawyers which obligations apply to you and on what grounds you may turn a request down.

## The data map of an agent platform

Start by listing where data goes. For an agent platform, a realistic map looks like this:

| Store | What personal data it can hold | Typical lifetime |
|---|---|---|
| Runs and step results | The user's message, every step's input and output, tool results, the answer | Days to weeks |
| Tool-call records | Which tool was called, when, by whom, and a summary of the arguments | Like runs, or longer as security evidence |
| Agent memory | Whole conversations, keyed by a session id that is often an email or phone number | Until someone sets a limit |
| <Term id="session-tool-cache">Session tool cache</Term> and saved values | Full tool results kept outside the prompt | Like memory |
| Captured runs and golden runs | Copies of real runs kept as test cases | Captures briefly; test cases until deleted |
| Approvals and paused runs | The proposed action, often quoting customer data | Until decided, then like runs |
| Audit log | Who did what: emails of staff, ids of runs | A year or more |
| Run manifests | A per-run record that can include rendered prompts | Until the run is gone and the audit-log window has passed |
| Traces, logs and metrics | Whatever the instrumentation captured | The tracing or log system's own retention |
| Backups | All of the above, as it was on the day | Your rotation |
| Outside systems | Model providers and tool servers that received the data | Their terms, not yours |

Two things about this map surprise people. Agent memory is often the largest store of personal data and the one with no default expiry. And the stores that matter most for security (tool-call records, the audit log) are the ones you want to keep longest, which pulls against privacy.

## Retention: what to purge and when

The GDPR's storage limitation principle asks that personal data be "kept in a form which permits identification of data subjects for no longer than is necessary" for its purpose (Article 5(1)(e)). In practice that means one <Term id="data-retention">data retention</Term> window per store, chosen by what the store is for:

- **Runs**: long enough to debug a complaint and investigate an incident, commonly weeks.
- **Tool-call records and security events**: as long as you need evidence of what tools were called with, often longer than runs. Keep them as summaries rather than raw arguments, so a long window holds less.
- **Memory**: as long as a returning user should be remembered. Without a limit, a support bot remembers every customer forever.
- **Test data**: captured production runs for days, until someone reviews them. Promoted test cases are deliberate copies; they need an owner and a review, not an age-based purge that silently breaks your regression suite.
- **Aggregates**: token and cost totals can outlive the runs if the person is removed from them.

Then make the purge boring and visible. It should run on a schedule, delete in small batches so it never locks the database, run on one instance at a time in a cluster, and record what it deleted (counts, never contents). Skip data under a legal hold. And check the first purge after you shorten a window: it deletes the whole backlog.

## Access requests: find and export

Under GDPR Article 15, a person can ask for "confirmation as to whether or not personal data concerning him or her are being processed", and Article 15(3) says "The controller shall provide a copy of the personal data undergoing processing." For an agent platform, the hard part is finding the data.

**Searching** every stored row for an email works, but it is slow and only finds exact text. A run that held the customer's id and not their email is missed.

**Indexing at write time** helps. When a run finishes, record which person it was about: take an identifier (customer id, email, session id), normalise it, and store a keyed hash of it beside the run. A <Term id="subject-reference">subject reference</Term> like this lets a later request find the runs by hashing the requested value the same way, without storing the value and without a full scan.

Three practical rules:

- **Match strictly.** A request that finds the wrong person's data and hands it over is a breach of its own. Match whole values only, and treat a phone number without a country code as a possible match for a person to check, not a hit.
- **Review before you send.** A run or a conversation found for one person can name others: a support thread about a second customer, a batch run over many accounts.
- **Deliver once.** Build the export, let it be downloaded once, and expire it after a short time. An export that sits on a server is one more copy to protect.

## Erasure: what can be deleted and what cannot

Article 17(1) sets out the <Term id="right-to-erasure">right to erasure</Term>: a person may obtain "the erasure of personal data concerning him or her without undue delay" where one of its grounds applies, the first being that the data are "no longer necessary in relation to the purposes for which they were collected or otherwise processed". A <Term id="data-subject-request">data-subject request</Term> to delete runs the same lookup as an access request, shows what it found, and deletes on confirmation.

What deletes cleanly:

- **Runs**, with everything recorded with them: tool-call records, approvals, recorded tool traffic, queue entries.
- **Memory sessions**, with their cached tool results and saved values.
- **Test data**: captured runs, golden runs and the test cases made from them. Deleting a test case weakens any release check that relied on it, so the platform should say so.

What is better changed than deleted:

- **Cost and usage rows**: clear the user, keep the tokens and cost, so budgets and spend reports do not move.
- **A staff member's authorship**: replace their email with a pseudonym wherever it records who created or approved something, and delete the account.

What cannot be deleted on request, and why:

- **Backups already written.** You cannot edit an offline backup. Instead, keep an erasure record (a tombstone: which row, when) and re-apply it whenever a backup is restored. Keep tombstones longer than your oldest backup.
- **Hash-chained audit logs and <Term id="signed-run-manifest">signed records</Term>.** Rewriting an entry breaks the chain or the signature, which is the point of them. Keep them for their own fixed period and let them expire, and keep payloads out of them where you can.
- **Copies outside your system**: logs and traces already shipped to another tool, model providers, MCP servers and anyone else the runs sent data to. Your erasure does not reach them.

Report those limits in the answer to the person. "We deleted your conversations and runs; copies in our backups expire within 30 days, and the deletion is applied again if one is restored; records of the requests we handled for you are kept for a year" is a better answer than "deleted".

## Legal holds and the legal-claims exception

Sometimes data must not be deleted: a dispute, an investigation, a regulator's request. A legal hold marks data as kept, whatever its age, until someone releases it.

Article 17(3)(e) says the right to erasure does not apply to the extent processing is necessary "for the establishment, exercise or defence of legal claims". In a system, that means:

- retention purges skip held data, and delete it at the first purge after the hold is released;
- deletes of held items are refused, and an erasure request deletes the rest and leaves the held rows, saying so;
- the hold records who placed it, why and when, and a release needs a reason too.

Scope holds narrowly (a project, a workflow, a list of runs, one person's records) and review them. A hold that nobody releases turns into indefinite retention. Whether the exemption applies to a specific case is a legal decision, not a technical one.

## Backups

Backups are where retention promises quietly fail. A 30-day retention on runs means little if nightly backups are kept for a year.

- **Rotate backups within the retention you promise**, or state the backup period in your notices.
- **Re-apply erasures on restore**, with the restore tool rather than a raw file copy, so deleted people do not come back.
- **Protect the keys with the backup.** Keyed hashes, tokens and erasure records for memory sessions only work with the same key. Losing it loses the ability to re-apply them.
- **Back up when you place a hold.** A hold inside an application does not stop someone with direct database access.

## Retention and erasure in L2M

L2M, a self-hosted agent platform, covers each part above on your own deployment. Every setting has a default, so a deployment that sets nothing still purges old runs; the subject-request and legal-hold features are opt-in and change nothing until used.

- **Retention.** Retention is set per kind of data: `EXECUTION_HISTORY_RETENTION_DAYS` (default 30) sets the window for run history, tool calls and rule events, while agent memory uses `AGENT_MEMORY_RETENTION_DAYS` (kept until you set it), captured runs go after 14 days and the audit log after 365. Golden runs and test cases, paused runs and release evidence are never deleted by age. A project can set its own values for runs, tool calls, rule events and memory ([data retention](/operations/data-retention#what-each-setting-deletes)).
- **Access requests.** Optionally, a workflow names up to three subject references, stored as HMAC-SHA-256 hashes. An admin, or a deployment-wide custom role with `data_subject:manage`, makes a request; L2M follows the references, can also search stored runs, approvals, memory, cassettes and evaluation data, and builds a zip that downloads once ([data-subject requests](/security/data-subject-requests)).
- **Erasure.** The same request can delete after a confirmed preview: runs with their tool calls, rule events, cassettes and approvals; memory sessions with their tool cache and artifacts; golden and captured runs; and the vault entries of tokens in those rows that stand for this person's values. Usage rows stay with the user cleared. For a staff member, the account is deleted, their email becomes a pseudonym, and their audit-log rows are kept. Logs, traces, knowledge bases, backups already written and outside systems are not covered ([deleting a person's data](/security/data-subject-requests#deleting-a-persons-data)). An erasure also leaves a stored run manifest in place; the manifest goes only when the audit-log retention has passed and the run itself no longer exists.
- **Legal holds.** A hold can name a whole project, one workflow, specific runs, or whatever the lookup finds for one person's identifier, and keeps them from purges, deletes and erasure until it is released ([what a hold covers](/operations/legal-hold#what-a-hold-covers)).
- **Backups.** Each erased row leaves an erasure record that `db:import` and `db:copy` re-apply after a restore, kept for `ERASURE_TOMBSTONE_RETENTION_DAYS` (400 by default). A file-level restore re-applies nothing ([erasures after a restore](/operations/backup-and-recovery#erasures-after-a-restore)).

The [webhook agent with memory](/recipes/webhook-agent-with-memory) recipe keys memory by `session_id`; a subject reference on `session_id` links such a session to the person. For the story of how these features arrived, read [retention, legal holds and data-subject requests](/blog/retention-legal-holds-and-subject-requests).

See also: [Keeping personal data and secrets out of AI prompts](/learn/security/sensitive-data-in-prompts), for holding less personal data in the first place.

## Further reading

- [GDPR Article 17: Right to erasure](https://gdpr-info.eu/art-17-gdpr/) (gdpr-info.eu, reproducing Regulation (EU) 2016/679)
- [GDPR Article 15: Right of access by the data subject](https://gdpr-info.eu/art-15-gdpr/) (gdpr-info.eu)
- [GDPR Article 5: Principles relating to processing of personal data](https://gdpr-info.eu/art-5-gdpr/) (gdpr-info.eu)
- In L2M: [Data retention](/operations/data-retention), [Data-subject requests](/security/data-subject-requests), [Legal holds](/operations/legal-hold)
