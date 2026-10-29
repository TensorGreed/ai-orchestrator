---
description: "Back up, restore and recover a self-hosted L2M deployment: what to keep, SQLite and Postgres methods, master-key loss, point-in-time recovery, RPO and RTO."
---

# Backup and recovery

This runbook covers backing up an L2M deployment, restoring it, and recovering from the loss of a database, a host or
the master key. Everything here is optional: an instance that is never backed up runs exactly as before, and SQLite
stays zero-config.

Every procedure below is run on every change to the backup scripts by the **restore drill**
(`scripts/dr-drill.mjs`, see [The restore drill](#the-restore-drill)): it populates an instance through the API, backs
it up with each method, restores into a fresh instance and checks that logins, secrets, workflows, runs, approvals and
the audit chain all came back.

## What to back up

| What | Where | Why |
|---|---|---|
| **The database** | SQLite: `apps/api/data/orchestrator.db` (or `DB_SQLITE_PATH`). Postgres: the database `DB_POSTGRESDB_*` points at. | Users, workflows, runs, secrets (encrypted), MCP servers, approvals, guard profiles, knowledge bases, releases, the audit log. |
| **The master key** `SECRET_MASTER_KEY_BASE64` | Your `.env`, the Helm secret (`secrets.secretMasterKeyBase64` or `existingSecret`), or your secret manager. | Secrets, MFA enrolments, log-stream credentials, the guard token vault and the audit signing key are encrypted with it. **A database backup without its key restores without them** (see [Lost master key](#restore-after-losing-the-master-key)). |
| Configuration | `.env` / `apps/api/.env`, Compose files, Helm values. | Settings, including `AUDIT_SIGNING_KEY_BASE64` if you set one. |
| Community nodes | `COMMUNITY_NODES_DIR` (default `apps/api/data/plugins`) when `COMMUNITY_NODES_ENABLED=true`. | Installed node packages are files, not database rows. |
| Git sync working tree | `GIT_SYNC_WORKDIR` (default `apps/api/data/git`). | Only if you use git sync; the remote repository is the real copy, so this is a convenience. |

**Store the master key apart from the database backups**, with its own access control (a secret manager, a sealed
envelope, a password vault). Someone who holds both can read every stored secret; losing the key alone loses the
secrets. Keep the key that encrypted each backup for as long as you keep that backup: after a key rotation, older
backups still need the old key.

With the default Compose stack, `./apps/api/data` on the host is mounted into the API container, so the SQLite file,
plugins and git working tree are there. With Helm, they are on the API's persistent volume claim
(`<release>-api-data`, mounted at `/app/apps/api/data`).

### What is safe to lose

These are not in a [`db:export`](#scheduled-backup-portable) backup and come back by themselves:
live sign-in sessions (users sign in again), pending sign-in and MCP OAuth challenges, caches (MCP tool cache, external
secret values), rate-limit counters and production-capture reservations, leader leases and the cluster's instance
registry, the webhook replay and idempotency windows, log-stream delivery history, and SQLite's full-text index
(rebuilt from the knowledge-base chunks as they are restored). A native backup (file copy, `pg_dump`, PITR) carries
them too; they are stale after a restore and expire as usual, except sessions, which stay valid until they expire
(see [Keep backups secret](#keep-backups-secret)).

### What happens to work in progress

A backup is a point in time. On restore:

- **Runs that were running** when the backup was taken are marked `error` with
  `interrupted: the server stopped while this run was in progress` when the restored instance starts (on a database
  instances share, only once they are older than the longest a run may last plus a minute). Retry them if needed.
- **Runs paused for approval** are durable: the approval request is restored and can be approved or rejected, and the
  run resumes. If the run was approved with agent tool results and the master key changed, those sealed results cannot
  be opened and the run asks for approval again.
- **Queued jobs** (`execution_queue`) are restored and run once a worker starts; jobs that were running are handled as
  after any crash (see [Queue and workers](./queue-and-workers.md)).
- **Anything after the backup is lost**: runs, edits, approvals and audit rows written after it. That window is your
  recovery point (RPO, below).
- After a portable restore, a webhook sender that retries a request the old instance had already accepted is not
  recognised as a duplicate (the idempotency window is not in the backup).

## Choosing a method

| Method | Store | While the API runs | Carries | Use it for |
|---|---|---|---|---|
| SQLite online backup | SQLite | yes | everything | scheduled SQLite backups |
| SQLite file copy | SQLite | **no**, stop it first | everything | a backup during planned downtime |
| `pg_dump` / `pg_restore` | Postgres | yes | everything | scheduled Postgres backups |
| Base backup + WAL archive (PITR) | Postgres | yes | everything, to any moment | the smallest data loss; recovering to just before a mistake |
| `db:export` / `db:import` | either | yes | every table except the transient ones above | moving to a new master key, a portable JSON copy, restoring onto a new build |
| `db:copy` | SQLite → Postgres | **no** | everything | moving to Postgres (also from a SQLite backup) |

**Native backups** (the first four) are the default: they are fast, carry everything byte for byte, and scale to large
databases. **The portable backup** (`db:export`) is a JSON file of the data with its audit-chain verdict recorded in it;
`db:import` re-encrypts secrets with a new master key and refuses a restore whose audit chain does not match the
backup. It holds the whole database in memory while exporting and importing, so prefer native backups for large
databases. A `db:export` backup restores into the **same kind of store** it came from; to move from SQLite to Postgres,
use `db:copy`.

## Procedures

The commands run from a checkout of the same L2M version as the deployment, on a host that can reach the database
(for SQLite, the host holding the file). `db:export` and `db:import` read their settings from the environment
(`DB_TYPE`, `DB_SQLITE_PATH`, `DB_POSTGRESDB_*`, `SECRET_MASTER_KEY_BASE64`), so export them in the shell first. Paths
given to the `pnpm --filter @ai-orchestrator/api` commands are relative to `apps/api`; absolute paths avoid surprises.

### Scheduled backup: SQLite

The online backup uses SQLite's backup API: it reads a consistent copy while the API keeps running.

```bash
pnpm --filter @ai-orchestrator/api exec node -e \
  "const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { readonly: true }); db.backup(process.argv[2]).then(() => db.close())" \
  /srv/l2m/apps/api/data/orchestrator.db "/backups/l2m-$(date +%Y%m%d-%H%M).db"
```

Run it from cron on the host that holds the file as often as your RPO needs, copy the files off the
host, and prune old ones. The backup file is a complete SQLite database: nothing else is needed to restore it.

Without that script, **stop the API and copy the file** together with `orchestrator.db-wal` and `orchestrator.db-shm`
if they exist. Never copy a live SQLite file with `cp`: the copy can be torn.

### Scheduled backup: Postgres

```bash
pg_dump --format=custom --no-owner --no-privileges \
  --file="/backups/l2m-$(date +%Y%m%d-%H%M).dump" --dbname="$DB_POSTGRESDB_URL"
```

`pg_dump` reads one consistent snapshot while the API runs. Use client tools of the server's major version or newer.
Keep the password out of the command line: give `--dbname` a URL without it and put the password in `PGPASSWORD` or
a `~/.pgpass` file (mode 600).
Managed Postgres services have their own snapshots and point-in-time restore: restore into a new database with them,
then continue at step 3 of [Restore to a fresh instance](#restore-to-a-fresh-instance).

### Scheduled backup: portable

```bash
export DB_TYPE=sqlite DB_SQLITE_PATH=/srv/l2m/apps/api/data/orchestrator.db   # or DB_TYPE=postgres + DB_POSTGRESDB_URL
pnpm --filter @ai-orchestrator/api db:export -- --out "/backups/l2m-$(date +%Y%m%d-%H%M).json"
```

Secrets, MFA secrets and sealed values are in the file **encrypted**; much else is not (below). `--exclude-history`
leaves out run history and the audit log (smaller, but the audit verdict is then not recorded).

### Keep backups secret

Every backup, native or portable, is as sensitive as the database. Stored secrets are encrypted with the master key,
but a backup also holds, in clear: user emails and password hashes, API key and MCP client token hashes, workflow
definitions (with anything typed into them), run inputs and outputs, the audit log, audit-export destination settings
(including their bearer tokens) and notification settings (including webhook URLs). A native backup also holds live
sign-in session ids; `db:export` leaves sessions out.

- **Encrypt backups at rest** (an encrypted bucket or volume, or `age` / `gpg` on the file) and **restrict who can
  read them**, as you would the database. Never store the master key in the same place.
- **After restoring from a copy you do not fully trust** (one that left your control, or a native backup of a
  compromised host), sign everyone out by deleting the sessions before reopening access
  (`DELETE FROM sessions`, with the API stopped), and rotate the API keys, MCP client tokens and audit-export tokens
  it holds.

### Restore to a fresh instance

1. **Stop every API instance and worker** that uses the target database (in cluster mode, scale every deployment to
   zero; with `SHUTDOWN_DRAIN_MS`, running queue jobs get that long to finish).
2. **Restore the data** into an empty location:
   - SQLite backup file: copy it to the instance's `DB_SQLITE_PATH` (default `apps/api/data/orchestrator.db`), with no
     `-wal` or `-shm` file of an older database beside it.
   - `pg_dump` file: create an empty database, then
     `pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DB_POSTGRESDB_URL" backup.dump`.
   - `db:export` file, into a database the API has **not** started on yet:
     ```bash
     export DB_TYPE=sqlite DB_SQLITE_PATH=/srv/l2m/apps/api/data/orchestrator.db  # or the Postgres settings
     export SECRET_MASTER_KEY_BASE64=...   # the key the backup was written with
     pnpm --filter @ai-orchestrator/api db:import -- --in /backups/l2m.json --yes
     ```
     `db:import` writes the whole backup in one transaction and checks the restored audit chain against the verdict
     in the backup before committing; anything that fails rolls the whole restore back. It logs each table as
     `restored`, or `emptied (not in the backup)` for a table an older backup does not hold. It refuses (exit code 2,
     nothing written):
     - a destination that already holds data (for example one the API started on, which created the admin and the
       default project). `--replace` replaces everything in it with exactly the backup: every exported table is
       emptied first, including ones the backup does not hold, and so are the destination's sign-in sessions, so
       everyone signs in again. `--merge` adds the backup's rows instead (best-effort;
       a conflicting row aborts it);
     - a backup whose secrets or MFA enrolments `SECRET_MASTER_KEY_BASE64` cannot open: it was written with another
       key. Give that key with `--source-master-key-file` (see [Change the master key](#change-the-master-key-planned-rotation)),
       or, when it is lost, pass `--allow-key-mismatch` and recover as in
       [Restore after losing the master key](#restore-after-losing-the-master-key). The check opens only the
       backup's first `secrets` and `mfa_secrets` rows: a backup with neither is not checked against the key.
3. **Start the API with the same `SECRET_MASTER_KEY_BASE64`** (and the same build, or a newer one: it migrates the
   schema forward at start). Start one instance first, then the rest.
4. **Verify** (below).

The bootstrap admin (`BOOTSTRAP_ADMIN_EMAIL`) is only created when the user table is empty, so a restored database
keeps its own users and passwords.

### Verify a restore

- Sign in as an admin (and as a user with MFA, if you use it).
- `GET /api/audit-log/verify-chain` (admin) answers `ok: true` with at least as many `rowsChecked` as before. For
  `db:import`, the output also prints the restored chain's verdict next to the one the backup recorded.
- Compare counts with the source or with the backup: users (`GET /api/users`), workflows, runs (`GET /api/executions`
  `total`), secrets, MCP servers, pending approvals (`GET /api/approvals`).
- Run a workflow that uses a stored secret. If it authenticates, the master key matches.
- Check the releases, guard profiles and knowledge bases you rely on, and export the audit bundle of a recent run:
  `l2m audit verify bundle.zip --public-key <key>` with the public key from **Settings → Audit Signing** before the
  incident proves the signing key came back.

The drill does these checks, plus approving a restored paused run and an agent's pending write-tool approval.

### Restore after losing the master key

Without the key the data is still there, but nothing encrypted with it can be read. The drill restores a backup with
a different key and checks each of these.

**Comes back:** users and password sign-in (passwords are hashed, not encrypted), workflows, run history, the audit
log and its chain, projects, roles, MCP servers, guard profiles, knowledge bases, releases, approvals.

**Is lost, and how to recover it:**

- **Stored secrets.** A run that uses one fails. Create each secret again with its value (from the provider), point
  the workflows and MCP servers that used it at the new secret, and delete the old one.
- **MFA.** Users with MFA cannot sign in: the code cannot be checked, and backup codes are checked after it, so they
  fail too. Removing an enrolment turns a second factor off, so treat it as part of the incident:
  1. **Record it** in the incident log: who ran it, when, and which accounts.
  2. With the API stopped, remove the enrolments of the affected users only (list them explicitly):
     ```bash
     # SQLite
     pnpm --filter @ai-orchestrator/api exec node -e \
       "const Database = require('better-sqlite3'); new Database(process.argv[1]).prepare(\"DELETE FROM mfa_secrets WHERE user_id IN (SELECT id FROM users WHERE email IN ('ana@example.com', 'ben@example.com'))\").run()" \
       /srv/l2m/apps/api/data/orchestrator.db
     # Postgres: check you are connected to the deployment's database, in one transaction
     psql "$DB_POSTGRESDB_URL" -v ON_ERROR_STOP=1 <<'SQL'
     BEGIN;
     SELECT current_database();
     DELETE FROM mfa_secrets WHERE user_id IN (SELECT id FROM users WHERE email IN ('ana@example.com', 'ben@example.com'));
     COMMIT;
     SQL
     ```
  3. **Before reopening access**, set `MFA_ENFORCE=true`, so admins must enrol again at their next sign-in, and
     ask every affected user to enrol again right after signing in. L2M has no forced password reset: if a reset
     account's password may be known to someone else, keep access closed for it (or delete the account and create it
     again with a new password) until that is settled.

  An admin route to reset one user's MFA is planned; until then this is the procedure.
- **Log-stream destinations** whose credentials were stored encrypted: enter them again.
- **MCP OAuth connections** (their tokens are stored secrets): connect again.
- **The guard token vault**: values tokenized before the loss cannot be turned back into the original.
- **The audit signing key** (when generated by L2M, not set with `AUDIT_SIGNING_KEY_BASE64`): signing fails with
  "cannot be read (was SECRET_MASTER_KEY_BASE64 changed?)" until an admin rotates to a new key
  (**Settings → Audit Signing**, or `POST /api/audit/signing-keys/rotate`).
- **Approved agent write-tool results** in runs paused for approval: they are sealed with the key, so after the
  restore the agent asks to approve those writes again. **Approving them runs the write a second time**: check what was
  already written first, or reject and re-run.
- **Production-capture surrogates** (the stand-ins replay capture writes in place of masked values) come from the key:
  values captured after the change get new surrogates that no longer match earlier recordings.

Set the new key in `SECRET_MASTER_KEY_BASE64` and keep it safe, as above.

### Change the master key (planned rotation)

Restore a portable backup with the new key, and give `db:import` the old one. It decrypts every encrypted column and
sealed value with the old key and encrypts it again with the new one: secrets, MFA secrets, log-stream credentials,
the guard token vault, and the approved write-tool results sealed inside paused runs (so an approved write is not run
again). A value the old key cannot open stops the import with the table's name, and nothing is written.

```bash
umask 077
printf '%s\n' "$OLD_KEY" > /secure/old-key.txt && chmod 600 /secure/old-key.txt
export DB_TYPE=sqlite DB_SQLITE_PATH=/srv/l2m-new/orchestrator.db     # an empty target
export SECRET_MASTER_KEY_BASE64="$NEW_KEY"
pnpm --filter @ai-orchestrator/api db:import -- --in /backups/l2m.json --yes --source-master-key-file /secure/old-key.txt
```

`--source-master-key-file` reads the old key from the first line of a file, so it never appears in the process list or
shell history (`--source-master-key <base64>` also works), and warns when the file is readable by its group or others.
Start the API on the new database with the new key. Keep the old key while you keep backups written with it.
Production-capture surrogates are derived from the key, so values captured after the change get surrogates that no
longer match earlier recordings.

### Point-in-time recovery on Postgres

PITR restores the database to any moment covered by your WAL archive, for example just before a bad deploy or a
mass deletion. It is Postgres's own mechanism; L2M needs nothing special. Managed Postgres offers it as a setting.
On a self-managed server:

1. **Turn on WAL archiving** (`postgresql.conf`, restart):
   ```ini
   wal_level = replica
   archive_mode = on
   archive_command = 'test ! -f /wal-archive/%f && cp %p /wal-archive/%f'   # or your tool: pgBackRest, WAL-G, barman
   archive_timeout = 60                                                    # archive at least once a minute
   ```
2. **Take base backups** regularly, while the API runs:
   `pg_basebackup -D /backups/base-$(date +%Y%m%d) -X stream -c fast -h db -U replicator`.
3. **To recover**: stop every API instance; restore the base backup into an empty data directory; add
   ```ini
   restore_command = 'cp /wal-archive/%f %p'
   recovery_target_time = '2026-10-29 14:05:00+00'
   recovery_target_action = 'promote'
   ```
   and an empty `recovery.signal` file; start Postgres. Once `SELECT pg_is_in_recovery()` answers `false`, it has
   replayed up to the target. Start the API (same master key) and verify.

The drill does this on its own throwaway cluster: changes made after the target time are gone, the ones before it are
there, and the API runs on the recovered database.

### Move from SQLite to Postgres

`db:copy` copies a SQLite file into an empty Postgres database and verifies it before committing (see
[Postgres](./postgres.md#moving-from-sqlite-db-copy)). It also works from a SQLite backup file, which makes it a
restore path when you rebuild on Postgres:

```bash
export DB_POSTGRESDB_URL=postgres://l2m:...@db:5432/ai_orchestrator   # an empty database
pnpm --filter @ai-orchestrator/api db:copy -- --from sqlite:/backups/l2m-20261029-0400.db --to postgres --yes
```

Start the API with `DB_TYPE=postgres` and the same master key.

## Cluster mode

- **Stop or drain every instance before a restore**, including webhook-only replicas and queue workers. An instance
  left running against a database being restored would write into it mid-restore or run against the old one.
- **One schema version.** Restore with the build that took the backup, or a newer one. A newer build migrates the
  schema forward at start, under the migrations lock, so instances starting together never migrate twice. Postgres
  refuses to start on a database whose recorded migrations have a gap this build would skip. `db:import` refuses a
  backup whose schema is newer than the destination's, and `db:copy` refuses a SQLite file of another schema version.
- **One leader.** With `HA_ENABLED=true` the leader is elected through a Postgres advisory lock, which belongs to a
  live connection and is never in a backup: once the instances start, one of them takes the lock. Instances recorded
  in the restored registry stop beating; the leader marks their inline runs interrupted as described in
  [Cluster operations](./cluster.md).

## RPO and RTO

The **recovery point** (RPO) is how much recent data a restore loses: everything after the backup used. The
**recovery time** (RTO) is how long from deciding to restore until the API answers again. Both are what the procedures
above achieve with the schedule you choose; L2M promises neither.

| Method | RPO | RTO is driven by |
|---|---|---|
| SQLite online backup | the interval between backups | copying the file, then the API start |
| SQLite file copy (API stopped) | the interval between backups (plus downtime to take it) | copying the file, then the API start |
| `pg_dump` / `pg_restore` | the interval between dumps | `pg_restore` (grows with data and indexes), then the API start |
| Base backup + WAL archive (PITR) | the WAL not yet archived: about `archive_timeout` | copying the base backup + replaying WAL since it, then the API start |
| `db:export` / `db:import` | the interval between exports | reading and writing every row as JSON in one transaction, then the API start |
| `db:copy` from a SQLite backup | the SQLite backup's interval | copying and verifying every row, then the API start |

Times the drill measured on a development machine (Node 24, local disk, Postgres 16 on the same host), for its
default database (3 finished runs plus the agent and approval runs, about 30 audit rows) and with
`DR_DRILL_RUNS=2000` (2,000 finished runs, about 4,000 audit rows). "Restore" runs from the start of the restore to
the API answering `/health`, which includes the API's own start of about 2 seconds:

| Method | Backup (default / 2,000 runs) | Restore (default / 2,000 runs) | Backup size at 2,000 runs |
|---|---|---|---|
| SQLite online backup | 0.01 s / 0.07 s | 2.5 s / 2.5 s | 15 MB |
| SQLite file copy (API stopped) | 0.00 s / 0.01 s | 2.3 s / 2.5 s | 15 MB |
| `db:export` / `db:import`, SQLite | 1.2 s / 1.6 s | 3.4 s / 4.6 s | 13.4 MB |
| `db:import` with a new master key | 1.2 s / 1.6 s | 3.6 s / 5.0 s | 13.4 MB |
| `pg_dump` / `pg_restore` | 0.12 s / 0.26 s | 2.7 s / 3.5 s | 0.9 MB (compressed) |
| `db:export` / `db:import`, Postgres | 1.2 s / 1.9 s | 4.1 s / 5.5 s | 13.6 MB |
| `db:copy` from a SQLite backup | — | 4.0 s / 5.6 s | (the SQLite backup) |
| PITR (base backup + WAL) | 0.39 s / 0.41 s | 3.2 s / 3.3 s | 62 MB (base backup) |

These are small databases, so the API start dominates. **Measure your own**: run the drill with `DR_DRILL_RUNS` near
your data size, or time a restore of a real backup into a scratch instance, and add the time to notice the failure,
decide, provision a host and fetch the backup.

What moves the numbers:

- **Database size.** Native methods copy pages and scale with bytes; the portable methods go row by row through JSON
  and hold the data in memory, so they slow down and need more memory as the database grows.
- **Backup interval.** The RPO of every scheduled method is its interval. Only WAL archiving gets below minutes.
- **Run history and the audit log** are usually the largest tables. `EXECUTION_HISTORY_RETENTION_DAYS` and
  `AUDIT_LOG_RETENTION_DAYS` bound them; `db:export --exclude-history` leaves them out.
- **Where the backup lives.** Fetching it from another region or from cold storage adds to the RTO.

## The restore drill

```bash
pnpm dr:drill                                                   # SQLite scenarios
DR_DRILL_POSTGRES_URL=postgres://postgres:...@localhost:5432/postgres pnpm dr:drill   # and Postgres
```

It starts the API on a temporary database (random free ports) and populates it through the public API: an admin, a
user with MFA, an operator, a secret, MCP servers, workflows, finished runs, a release, a guard profile, a knowledge
base, a signed run manifest, a run paused for approval, and an agent paused on its second write-tool approval with the
first write's result sealed. It backs that up with every method above, restores each backup into a fresh instance and
verifies it:

- password and MFA sign-in;
- the secret decrypts (a run sends it to a local echo server that only reports whether it matched);
- users, workflows, runs (with their status), secrets, MCP servers, releases, guard profiles, knowledge bases and the
  pending approvals (with their request ids) match;
- every audit row is there and the chain verifies; the stored manifest is unchanged, and a run signed after the
  restore verifies with `l2m audit verify` against the public key taken before the backup;
- the paused run can be approved and finishes; approving the agent runs its second write only, the first being
  answered from its sealed result, also after a key rotation.

It also restores with a lost master key and walks the recovery above (the agent asks for its first write again;
signing fails until the key is rotated), and checks that `db:import` refuses a key that cannot open the backup. Any
difference fails it with a diff. It prints the measured times.

| Setting | Effect |
|---|---|
| `DR_DRILL_POSTGRES_URL` (or `TEST_POSTGRES_URL`) | A Postgres server where the role can create databases; the drill creates and drops its own `l2m_drill_*` databases. Without it, the Postgres scenarios are skipped. |
| `DR_DRILL_REQUIRE_POSTGRES=true` | Fail instead of skipping without Postgres. |
| `DR_DRILL_PITR=true` | Also run point-in-time recovery on a throwaway cluster (needs `initdb`, `pg_ctl` and `pg_basebackup`; `DR_DRILL_PG_BIN` names their directory). The cluster's Unix socket lives in a directory under `TMPDIR`, and a socket path is limited to about 100 characters: with a long `TMPDIR`, point it at a short directory (for example `TMPDIR=/tmp`). |
| `DR_DRILL_RUNS=<n>` | Give the source `n` finished runs instead of 3, to time a bigger database. |
| `--only sqlite` / `--only postgres`, `--keep`, `--summary <file.json>` | Run one store; keep the work directory; write the results as JSON. |

The master keys, passwords and the secret value are generated per run and never printed. The drill refuses to run if
`apps/api/.env` sets a database, port, key or bootstrap setting, since the API would load it over the drill's own.

CI runs it in the **DR drill** workflow (`.github/workflows/dr-drill.yml`) on pull requests that touch the backup
scripts, the database layer, the API's services or `app.ts`, the lockfile, the drill or this page, every week, and on
demand, with Postgres and PITR.
