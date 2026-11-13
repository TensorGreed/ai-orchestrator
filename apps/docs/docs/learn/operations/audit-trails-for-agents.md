---
title: "Audit trails for AI agents: record, sign, prove"
sidebarTitle: "Audit trails for agents"
description: "What an agent audit trail should record (inputs, tool calls, approvals, versions), how a signed run manifest proves it is intact, and offline checks."
level: intermediate
about: signed-run-manifest
related: [signed-run-manifest, audit-log, approval-gate, data-retention, legal-hold]
demo: wf-demo-refund-approval
demoRecorded: true
---

# Audit trails for AI agents

An audit trail for an AI agent is a record that lets someone else answer, later and without trusting you, what one run did: the input it got, the workflow version and model it ran with, every tool it called and with what result, who approved what, and what it answered. Two things make it useful. It has to be complete enough to reconstruct the run, and it has to be tamper-evident, so a reader can check that nobody changed it after the fact. The usual way to get the second is to hash the record and sign the hash with a key the platform holds.

## What auditors ask

The questions that come after an incident, a complaint or a review are concrete:

- **What did the agent do?** Which tools did it call, in which order, with which arguments, and what came back?
- **Why did it do that?** What prompt, which model and which settings was it running with? Which documents did retrieval put in front of it?
- **Who let it?** Who started the run, who approved the risky step, and was any rule supposed to stop it?
- **Is this the real record?** Was the log written by the system at the time, or assembled later? Has anything been removed?
- **What was it running?** Which version of the workflow, and has that version changed since?

An ordinary application log answers some of these. It usually misses the version and the approvals, and it rarely proves anything about its own integrity.

## What to record per run

Think of one run as the unit of evidence. For each run, keep:

| Record | Why it matters |
|---|---|
| Trigger, start and end time, status, who or what started it | Places the run and its owner. |
| A hash of the workflow definition and its version number | Proves which logic ran, even after someone edits the workflow. |
| Each step's status and timing, and a digest of its input and output | Shows the path, and lets you check stored payloads against the record. |
| Each model call: provider, model, parameters, tokens, cost | Answers "which model, with which settings". |
| Each tool call: tool, server, a digest of the arguments and result, the outcome | The core of an agent's trail. Include calls that were refused. |
| Prompts and retrieved sources | Shows what the model was told and shown. |
| Approval decisions and policy outcomes | Shows where a person or a rule intervened. |
| Totals | Tokens, cost, number of model and tool calls. |

Two kinds of thing stay out. **Secrets**: record which credential was used (its id), never its value. **Bulky or sensitive payloads**: put a digest in the record and keep the payload beside it, so the record stays small and can be shared without the content.

Alongside the per-run record, keep an <Term id="audit-log">audit log</Term> of actions people and keys take on the platform itself: sign-ins, role changes, new API keys, edits to rules and secrets, exports. A run record says what the agent did; the audit log says who changed the system it ran on.

## Tamper evidence: hashes and signatures

A record you can edit freely proves nothing. Two techniques make editing visible.

**Digests.** Serialise the record in one fixed form (sorted keys, no whitespace), then compute a SHA-256 hash. Change one character and the hash changes. Store digests of large payloads inside the record, and the record's own hash then covers them too.

**Signatures.** A hash alone can be recomputed by whoever changes the record. So the platform signs the hash with a private key that never leaves the server. Anyone with the matching public key can check the signature; nobody without the private key can produce a valid one for a changed record.

A <Term id="signed-run-manifest">signed run manifest</Term> combines both: one document per run, holding the fields above and digests of everything bulky, signed by the deployment.

**Hash chains** are the equivalent for an append-only log. Each entry stores the hash of the entry before it, so deleting, inserting or reordering a row breaks the chain at that point.

Two limits are worth stating plainly. A signature proves the record has not changed since it was signed; it says nothing about whether the platform recorded the truth in the first place. And a digest of a short or guessable value (a yes/no answer, a short code) can be confirmed by guessing, because anyone can hash the guess and compare.

## Verifying offline

An audit trail that only the platform can check is weak evidence. The reader should be able to check it on their own machine, with no network access, no account on the system and no hosted service in between.

That takes three things:

1. **An export** that holds the signed record, the payloads it refers to, and a signed index of every file with its hash and size, so a changed, added or removed file breaks verification.
2. **A verifier** that recomputes every hash and checks the signature.
3. **The public key, from a channel the reader trusts.** This is the step people skip. If the verifier uses a key embedded in the export, the check only shows the export is internally consistent: whoever changed it could re-sign it with their own key and embed that. The key has to come from the deployment's operator by some other route.

## Approvals and policy decisions in the record

For agents, the moments where something stopped or paused the run matter as much as the steps that ran. Record each of them as data, not as a free-text log line:

- **Human approvals.** For each <Term id="approval-gate">approval gate</Term>: who decided, approve or reject, the reason, and when. If the approver edited the proposed action, record which fields changed and a keyed digest of the edits, rather than the edited values, so the record proves an edit happened without exposing it. Record requests that timed out or were cancelled too. See [human in the loop](/learn/agents/human-in-the-loop) for where approvals belong.
- **Tool policy outcomes.** A tool call refused by policy, rate limited or stopped by a circuit breaker is evidence that a control worked. Record the outcome next to the call.
- **Rule verdicts.** If rules inspect inputs and outputs, record which rule set and version decided, the action and the outcome, without the matched content.

## Retention versus audit

Privacy practice says delete what you no longer need. Audit says keep the evidence. For agents the tension is sharp, because run history holds what users typed and what tools returned.

A workable split:

- **Keep run payloads briefly** under a <Term id="data-retention">data retention</Term> setting, because they hold personal data.
- **Keep the audit log and signed manifests longer.** They hold mostly ids, digests and decisions rather than payloads. Check what else they keep: a manifest that records rendered prompts still carries what the user typed.
- **Suspend deletion for a matter** with a <Term id="legal-hold">legal hold</Term>, so evidence for a dispute survives the normal purge.

Once the payloads are gone, the manifest still proves what happened in outline: which tools ran, with which outcomes, approved by whom. It no longer holds node inputs, outputs or tool results, only their digests. Decide which questions you need to answer a year from now before you set the windows.

## Regulatory context

Record-keeping for AI systems appears in regulation and guidance. Article 12 of the EU AI Act says that high-risk AI systems "shall technically allow for the automatic recording of events (logs) over the lifetime of the system", and lists purposes, such as identifying situations that may present a risk and monitoring the system's operation. NIST AI 600-1, the Generative AI Profile of the AI Risk Management Framework, is a companion resource for generative AI, and NIST describes the framework as "intended for voluntary use".

Neither text prescribes a file format or a signature scheme, and whether an obligation applies depends on what your system is and how it is used. Treat the techniques on this page as engineering that supports record-keeping, not as compliance in themselves. Ask your legal team which obligations apply to you.

## Audit trails in L2M

L2M, a self-hosted workflow builder and agent runtime, keeps both kinds of record on your own deployment. None of it needs a hosted service.

- **Run manifest.** Every finished run can produce a versioned JSON manifest: run status and timing, the workflow's SHA-256 hash and version, per-node status and digests, model calls with tokens and estimated cost, MCP tool calls with argument and result digests and an outcome such as `ok`, `error`, `policy_blocked`, `rate_limited` or `breaker_rejected`, prompts, citations, approvals and totals. Configs keep secret references only. The manifest is made the first time someone asks for it, then stored and served unchanged ([the run manifest](/security/audit-bundles#the-run-manifest)).
- **Signing.** Manifests and bundles are signed with Ed25519. Optionally set `AUDIT_SIGNING_KEY_BASE64`; otherwise L2M generates a key on first use and stores it encrypted. Admins see the public key and its id under **Settings → Audit Signing** ([signing keys](/security/audit-bundles#signing-keys)).
- **Audit bundle.** `GET /api/executions/:id/bundle` (or **Audit bundle** on the Runs page) returns a zip with the manifest, a signed index, the workflow as it ran, each node's input and output, the trace, logs and output files. Secret values the deployment holds are replaced with `[REDACTED]` before anything is written.
- **Offline check.** `pnpm l2m audit verify l2m-audit-<id>.zip --public-key audit-key.pub.pem` checks the zip, the signature, every file's digest, the manifest digest and the workflow hash. It exits 0 when everything passed with your key, 1 when a check failed, 2 on a usage error, and 3 when no `--public-key` was given (and `--trust-embedded-key` was not), so the signer was not verified ([verifying a bundle offline](/security/audit-bundles#verifying-a-bundle-offline)).
- **Approvals.** Approval decisions go into the manifest and into the audit log (`approval.requested`, `approval.decided`, `approval.timed_out` and others), with the reason, the edited field keys and an HMAC digest of the edits ([audit and the run manifest](/product/approvals#audit-and-the-run-manifest)). The manifest also summarises content rule verdicts, without matched content.
- **Audit log.** Sign-ins, role and key changes, secrets, approvals, releases, legal holds and run actions such as `execution.started` and `execution.audit_bundle.export` are written to a hash-chained audit log, on by default. Admins can list and export it as CSV, check the chain with `GET /api/audit-log/verify-chain` (after retention prunes old entries, the check starts from the checkpoint the prune writes), and optionally ship it to an HTTP endpoint or a file as NDJSON that carries each row's hash ([audit log](/security/audit-log)).
- **Retention.** Run history is kept 30 days by default (`EXECUTION_HISTORY_RETENTION_DAYS`) and the audit log 365 days (`AUDIT_LOG_RETENTION_DAYS`). A stored manifest is pruned only when it is older than the audit-log retention and its run's history is gone. The manifest keeps rendered prompts, so it can hold user text for as long as the audit log is kept. A legal hold keeps a run's history, and the run keeps its manifest; the audit log follows its own retention ([data retention](/operations/data-retention#what-each-setting-deletes)).

The live demo has a refund workflow that pauses at an Approval Gate for a person to approve or edit the reply: the kind of decision a manifest records.

<TryInDemo workflow="wf-demo-refund-approval" recorded />

See also: [Identity for AI platforms](/learn/operations/identity-for-ai-platforms), for who the actors in an audit log are.

## Further reading

- [EU AI Act, Article 12: Record-keeping](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-12) (AI Act Service Desk, European Commission)
- [NIST AI 600-1: Generative Artificial Intelligence Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) (NIST, July 2024)
- L2M docs: [Audit bundles and signed run manifests](/security/audit-bundles), [Legal holds](/operations/legal-hold)
