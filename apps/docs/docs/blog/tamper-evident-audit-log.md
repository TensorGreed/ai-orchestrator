---
title: "A tamper-evident audit log that can still delete"
description: "How a hash-chained audit log works, why it must hash exactly what it stores, how retention deletes old entries without breaking the chain, and its limits."
date: 2026-11-16
author: "The L2M team"
socialCard: true
---

# A tamper-evident audit log that can still delete

An audit log records who did what: who signed in, who changed a role, who rotated a key, who approved a run. It is only worth keeping if a reader can tell whether it was changed afterwards. L2M has had a hash-chained audit log since May 2026, and on 13 November 2026 we merged a round of fixes that made it hold up under two pressures every real log faces: old entries must be deleted, and copies must leave the database. This post explains how the chain works, the mistakes that are easy to make with one, and what a chain can and cannot prove.

## Tamper-evident, not tamper-proof

Crosby and Wallach's paper on tamper-evident logging states the goal well: "While tamper-resistance for such a system might be impossible, tamper-detection should be guaranteed in a strong fashion." Whoever can write to the database can change a row. What you can get is a log where such a change shows.

The classic tool, and the one L2M uses, is a hash chain. (The paper itself proposes a tree that is cheaper to audit.) Each entry stores the hash of the entry before it and a hash of itself that covers that previous hash:

```
entry_hash = SHA-256(prev_hash || canonical form of the entry)
```

The first entry points back to 64 zeros. Change one entry and its own hash no longer matches. Recompute that hash to hide the edit and the next entry's `prev_hash` no longer matches. Delete, insert or reorder entries anywhere but at the very end and a link breaks. A check walks the entries in the order they were written and stops at the first that fails.

In L2M the check is **Settings → Audit Log → Verify chain integrity**, or `GET /api/audit-log/verify-chain`. It answers `ok`, how many entries it checked, and the first broken entry with the hash it expected and the one it found.

## Mistake 1: a canonical form that drifts

The hash covers a "canonical form" of the entry, and that form must never change, or every old entry fails the day you upgrade. Two things keep it stable in L2M:

- The fields are hashed as a JSON **array in a fixed order**, so the form does not depend on how a serializer happens to order an object's keys.
- The form has not changed since May 2026. Old entries must keep hashing exactly as they did, so any new field would need a new, versioned form rather than a quiet edit.

## Mistake 2: hashing what you meant to store

We fixed this one in October. A JavaScript string can hold a lone UTF-16 surrogate, a half of a character pair. `JSON.stringify` escapes it as text, but the database drivers store UTF-8, which has no form for it. The Postgres driver replaces it with U+FFFD; the SQLite driver did the same on Node 24 but wrote a different byte form on Node 20.

The writer hashed the string it was given, and the database kept something else. From then on the check could never match that entry, and it stopped there, leaving every later entry unchecked. One request from a user allowed to create tags was enough: `POST /api/tags {"name":"\ud800"}`.

The fix is a rule worth stating for any hash chain: **hash exactly what is stored, after the store has done whatever it does to it**. Every text field is now made well-formed (lone surrogates and U+0000 become U+FFFD, as Postgres stores them) before it is hashed and stored, so both see the same bytes. SQLite text is read back as its stored bytes, so an entry verifies the same on any Node version.

Old entries needed care too. For an entry with one U+FFFD whose hash fails, the check tries every character the store could have replaced at that position (2,049 candidates); a match proves the entry is exactly what was written. With two or more, the combinations cannot all be tried, so the entry is reported as `unverifiable`, with its position in the chain, and `ok` is `false`. The check continues past it, because the next entry's `prev_hash` still pins it. What it never does is call an entry intact when it could not check it.

## Mistake 3: retention that breaks the chain

Logs cannot grow forever, and personal data in them should not be kept forever either. L2M deletes audit entries older than `AUDIT_LOG_RETENTION_DAYS` (365 by default). But delete the oldest entries and the first entry left no longer points back to 64 zeros. Before the fix, retention deleted entries by their timestamp, and the check failed on every deployment older than the retention period. A check that always fails teaches people to ignore it.

The fix has three parts:

1. **Delete a prefix only.** A purge deletes oldest-first in the order written and stops at the first entry inside the retention window, so a gap can never open in the middle.
2. **Write a checkpoint.** In the same transaction, the purge appends an entry, `audit.retention_checkpoint`, recording the hash of the last deleted entry (`anchorHash`), the id of the first entry left, the cut-off and the count. The checkpoint is an ordinary chained entry: its content is hashed, and later entries pin it.
3. **Check the anchor.** The check accepts a chain that does not start at 64 zeros only if the latest checkpoint names exactly the first entry left and the hash it points back to, and is plausible: the first entry left is not older than the cut-off, the cut-off is at least a day before the checkpoint, and the checkpoint is not dated in the future.

Deleting more entries from the start, or editing the first entry's `prev_hash`, still fails. Editing any entry that remains, the checkpoint included, still fails at that entry.

## What the chain cannot prove

This is the part most write-ups skip. The chain is an unkeyed hash. It proves order and content, not authorship. The cheapest attack needs no hashing at all: deleting the newest entries leaves a shorter chain that still verifies, because nothing records where the chain should end. Only an outside copy that already holds those entries shows the gap. Beyond that, someone with write access to the database can delete entries from the start of the chain, up to about a day before now, and append a checkpoint of their own, or simply recompute the whole chain after an edit. The plausibility rule makes a forged checkpoint harder to make look natural; it cannot rule one out.

Crosby and Wallach make the same point about an untrusted logger: without something outside it, the logger "is free to have different snapshots make inconsistent claims about the past". The answer is always a copy, or a commitment, held somewhere the database's writers cannot reach.

## The copy outside is the real anchor

L2M ships the log out two ways:

- **Export destinations** (optional) send entries in order, in batches of NDJSON with each entry's `entryHash`, to an HTTP endpoint or a file under `AUDIT_EXPORT_FILE_ROOT`. Each destination keeps a cursor; a failed batch is sent again from the same entry. Delivery is at least once, so de-duplicate on `id`. A run used to send one batch of 500 per interval, so a busy deployment fell further behind with each interval unless someone changed the interval or the batch size; a run now drains the backlog in bounded batches (at most 20 per run, and again at the next check while more is waiting).
- **Log streams** send each event to syslog, a webhook or Sentry soon after it is written. They are a live feed, not a guaranteed copy: events wait in memory and are lost if the process stops.

Use an export destination when every entry must arrive. Scheduled export is off until you set `AUDIT_EXPORT_ENABLED=true`; without it, only **Run now** sends anything. Exported entries carry each `entryHash`, so you can compare the copy with the database later, entry by entry, and see exactly where they differ. For a single run's record (not the audit log), a [signed audit bundle](/security/audit-bundles) adds a signature with a key, checkable offline.

Backups keep the verdict too. `db:export` records whether the chain verified, and `db:import` refuses a restore whose chain does not match that verdict, so a backup cannot quietly launder a broken log. (`--allow-audit-change` restores anyway, printing both verdicts and a warning.)

## Mistake 4: writing a secret into a record you cannot edit

The last fix is a lesson about immutability itself. An HTTP export destination usually needs an ingestion token in a header. Earlier releases stored those header values in plain text, returned them to admins, and wrote the whole update body, token included, into the `audit_export.destination.updated` entry.

Header values are now sealed with the master key, shown as `__secret__` in every answer, and the audit entry records which fields changed, the name, interval and enabled flag, the config keys, the URL's host and the header names. But the old entries cannot be cleaned: editing them would break the chain, which is the point of the chain. If a header token, or a URL with a credential in it, was ever sent in a `PUT` to a destination on an older release, the only fix is to rotate it.

Lesson: decide what goes into an append-only record with the same care as what goes into a public one, because you cannot take it back.

## What it does not do

- It does not stop someone with database access from rewriting the chain; it makes edits visible to anyone holding an outside copy.
- The chain carries no signature. Signed manifests exist per run, through audit bundles.
- Log streams can lose events; export destinations deliver at least once, not exactly once.
- A chain purged by a release before checkpoints reports as broken at its first entry until the next purge writes a checkpoint. `AUDIT_LOG_RETENTION_DAYS=0` keeps every entry.

## Try it in L2M

The audit log is on by default and needs no setup; only admins can read it. The [audit log page](/security/audit-log) covers searching, CSV export, the chain check, export destinations and log streams. [Data retention](/operations/data-retention) lists what else is purged and when, and [backup and recovery](/operations/backup-and-recovery) covers the verdict on restore. For what a per-run record should hold, read [Audit trails for AI agents](/learn/operations/audit-trails-for-agents).

## Further reading

- Scott A. Crosby and Dan S. Wallach, [Efficient Data Structures for Tamper-Evident Logging](https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf) (USENIX Security 2009)
- [Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final), NIST SP 800-92
- Pull requests: [#71 the chain on both databases and the text fix](https://github.com/TensorGreed/l2m/pull/71), [#73 the verdict in backups](https://github.com/TensorGreed/l2m/pull/73), [#213 retention checkpoints, sealed headers and bounded export](https://github.com/TensorGreed/l2m/pull/213) (GitHub)
