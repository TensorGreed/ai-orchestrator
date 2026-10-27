# Postgres

L2M runs on **SQLite by default, with nothing to configure**: the API keeps its data in `apps/api/data/orchestrator.db`
and creates the schema on first start. Postgres is optional. Choose it when you want a managed database server, its
backups and replication, or more than one API instance on one database.

Everything in this page is opt-in. Leaving `DB_TYPE` unset (or `sqlite`) keeps the default.

## Choosing Postgres

Set `DB_TYPE=postgres` (or `postgresql`) and point the API at the database, either with one URL or with separate
variables. The URL wins when both are set.

```bash
DB_TYPE=postgres
DB_POSTGRESDB_URL=postgres://l2m:secret@db.example.com:5432/ai_orchestrator?sslmode=verify-full
```

```bash
DB_TYPE=postgres
DB_POSTGRESDB_HOST=db.example.com      # default localhost
DB_POSTGRESDB_PORT=5432                # default 5432
DB_POSTGRESDB_DATABASE=ai_orchestrator # default ai_orchestrator
DB_POSTGRESDB_USER=l2m                 # default postgres
DB_POSTGRESDB_PASSWORD=secret
DB_POSTGRESDB_SSL=true                 # default false
DB_POSTGRESDB_POOL_SIZE=10             # default 10 (1-1000)
```

The settings are validated at startup, and only when `DB_TYPE=postgres`. A bad value stops the API with a message that
names the variable, never its value; the password is never logged. The startup line shows the target as
`postgres user@host:port/database` and whether TLS is on and verified.

On first start the API applies its migrations to the database (under an advisory lock, so instances starting together
never run them twice). The database must exist; the API creates its tables in the connecting role's default schema.

### TLS

With TLS on, the server certificate and host name are **verified by default**.

| Setting | Effect |
|---|---|
| `DB_POSTGRESDB_SSL=true` | TLS on, certificate verified against the system CAs. |
| `sslmode=require`, `verify-ca` or `verify-full` in the URL | TLS on; all three verify the certificate and host name here. |
| `sslmode=disable` in the URL | TLS off. `allow` and `prefer` are refused, since they could fall back to plain text. |
| `DB_POSTGRESDB_SSL_CA` | Your provider's private CA: a path to a PEM file, or the PEM itself. |
| `DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED=false` | Turns certificate checks off. The API prints a warning at every start: the connection can be intercepted. Prefer `DB_POSTGRESDB_SSL_CA`. |

When the URL has an `sslmode` and `DB_POSTGRESDB_SSL` is also set, the two must agree, or startup fails. The URL
accepts no other query parameters.

### Docker Compose

The default `docker compose up` runs SQLite. An optional profile runs the same stack on Postgres beside it:

```bash
docker compose --profile postgres up --build
```

That starts a `postgres:16-alpine` service (data in the `l2m-postgres` volume), the API on
`http://localhost:4001` with `DB_TYPE=postgres`, and the web UI on
`http://localhost:5174`. The Postgres service is reachable only inside the compose network.
Without `--profile postgres`, none of these services start.

## Moving from SQLite: db:copy

`db:copy` is an optional command that copies a SQLite database into an **empty** Postgres database, verifies the copy,
and only then commits it.

```bash
pnpm --filter @ai-orchestrator/api db:copy -- --from sqlite:<path> --to postgres --dry-run
pnpm --filter @ai-orchestrator/api db:copy -- --from sqlite:<path> --to postgres --yes
```

- Settings are read **exactly as the API reads them**: the environment, then the repo's `.env` (which does not
  override the environment), then `apps/api/.env` (which overrides both). So `--from sqlite` and the target are the
  file and database the API itself would use.
- `--from sqlite:<path>` is the SQLite file, opened read-only. `--from sqlite` alone uses the API's file:
  `DB_SQLITE_PATH`, else `apps/api/data/orchestrator.db`. A relative path is relative to `apps/api` (where
  `pnpm --filter` runs the command).
- `--to postgres` uses the same `DB_POSTGRESDB_URL` / `DB_POSTGRESDB_*` settings as the API, including TLS.
  `DB_TYPE` does not matter here.
- db:copy first prints the resolved source file and the target (`postgres user@host:port/database` and its TLS
  mode, never the password). Without `--yes` or `--dry-run` it stops there, so you can check both.
- `--dry-run` runs every check and prints the row counts, writing nothing. `--yes` copies.
- `--allow-broken-audit` copies a file whose audit chain is broken (refused by default, see below).

### Step by step

1. **Upgrade the SQLite file to this build.** db:copy refuses a file whose schema is older than the build running it
   (it names what is missing: a table, column, index, trigger or migration marker). Start this build once against
   the file (`DB_SQLITE_PATH=<path> pnpm --filter @ai-orchestrator/api start`, wait until it listens, stop it).
   `apps/api/.env` beats the shell, so if that file sets `DB_SQLITE_PATH` (or `DB_TYPE`), the shell prefix is ignored
   and the start would open the file named there: set `DB_SQLITE_PATH=<path>` in `apps/api/.env` for that one start
   and put it back afterwards. If `DB_TYPE` resolves to `postgres`, set `DB_TYPE=sqlite` where it wins too, or the
   start boots against the Postgres target, bootstraps an admin there, and db:copy then refuses the target as
   non-empty. The refusal prints the right command for the files you have and warns about `DB_TYPE=postgres`. A file
   written by a *newer* build is refused too; run db:copy from that build.
2. **Create an empty Postgres database.** db:copy migrates a database with no tables itself, through the same
   migrations the API runs. It refuses a database that holds any user or workflow, or rows the migrations did not put
   there, and one at a different schema version.
3. **Stop the API.** The copy needs downtime: writes made to SQLite after the copy starts are not copied. (db:copy
   reads one consistent snapshot of the file, and while it runs it holds the migrations lock on the target, so an
   API instance started against Postgres waits for it.)
4. **Rehearse:** run db:copy with `--dry-run`. Fix anything it refuses.
5. **Copy:** run it with `--yes`. The whole copy is one transaction: if any table fails, or any check below fails,
   nothing is committed and the target stays as it was (migrated and empty), so you can fix the cause and run it again.
   A row that breaks a unique constraint on Postgres is named with its table and constraint. The audit chain is read
   in batches, so a long chain does not need more memory.
6. **Switch the API:** set `DB_TYPE=postgres` and the `DB_POSTGRESDB_*` settings, keep **the same
   `SECRET_MASTER_KEY_BASE64`**, and start it.
7. Keep the SQLite file. It is your way back, and the record for any audit row Postgres cannot verify (below).

The Compose profile's Postgres service publishes no port to the host. To copy into it, publish one while you copy
(for example `ports: ["127.0.0.1:5432:5432"]` on the `postgres` service), then run db:copy from a checkout on the host
with `DB_POSTGRESDB_URL=postgres://l2m:l2m-local-only@127.0.0.1:5432/ai_orchestrator`. The profile's API uses the same
`SECRET_MASTER_KEY_BASE64` as the default one.

### What is copied, and how

- Every table, parents before children, in the order rows were inserted. Transient tables (caches, leases, webhook
  replay windows) are copied too; they expire as usual.
- Values are converted the way the Postgres store writes them: timestamps as stored (SQLite's text, read as UTC; an
  empty string becomes NULL), JSON text verbatim, U+0000 in text as U+FFFD (Postgres text cannot hold it). A
  fractional value in an integer column is rounded, and the summary says how many.
- **Secrets are copied encrypted** (ciphertext, IV and auth tag), never decrypted. The API on Postgres needs the same
  `SECRET_MASTER_KEY_BASE64`, or it cannot read them.
- Knowledge-base full-text search is rebuilt by Postgres from the copied chunks.

### What is verified

Before committing, in the same transaction:

- the row count of every table;
- a checksum over every table's primary keys;
- for tables ordered by insertion (the audit log, knowledge-base chunks, MCP history and others), that Postgres keeps
  the SQLite insertion order;
- the audit log hash chain, on both sides: the chain on Postgres must give exactly the verdict expected from the SQLite
  rows, and every row SQLite verified must verify on Postgres (except the rows described below). The summary prints
  both verdicts.

### A broken audit chain on SQLite

Before writing anything, db:copy verifies the SQLite chain from the bytes it stores. If the chain is **broken**, db:copy
refuses, naming the first broken row: something changed the audit log, and Postgres could hide it (characters
Postgres cannot store become U+FFFD, and a verifier on Postgres may then accept the row). Investigate the row first
(compare it with a backup), or keep the evidence with `db:export` and keep the SQLite file.

`--allow-broken-audit` copies anyway. The summary then says, also as its last line, where the SQLite chain was broken
and that the Postgres audit verdict cannot be trusted to show it; it never reports the Postgres chain as intact.

### Audit rows Postgres cannot store exactly

SQLite kept two kinds of character in audit text that Postgres cannot store: U+0000, and lone UTF-16 surrogates
written by older builds. On Postgres each becomes U+FFFD. The verifier tries every character one U+FFFD in a row could
have been, but not every combination for two. So a row SQLite verified may become "cannot be verified" on Postgres
when, once U+0000 and lone surrogates become U+FFFD, it holds **two or more U+FFFD** (for example two NULs, or one NUL
beside a real U+FFFD). db:copy decides this from the SQLite row itself, names those rows, and the chain on Postgres
reports them as "cannot be verified" (the rest of the chain is still verified). This is a known limit; keep the SQLite
file as their record. Rows SQLite could not verify stay "cannot be verified". Anything else stops the copy: a row that
would turn *broken* on Postgres, or a row that would become unverifiable without its SQLite text explaining it.

## Backup and restore

- **Postgres:** use your usual tools (`pg_dump` / `pg_restore`, or your provider's snapshots).
- **SQLite:** stop the API and copy the file, or use `db:export`.
- `db:export` / `db:import` write and read a JSON backup of the main tables on either store (`--exclude-history` skips
  execution history and the audit log). A backup restores into the same kind of store it came from: to move from
  SQLite to Postgres, use db:copy. Secrets stay encrypted in the backup; `db:import --source-master-key` re-encrypts
  them when the master key changed.
- `db:export` reads one consistent snapshot and records the audit chain's verdict in the backup. `db:import` restores
  in one transaction and checks the restored chain before committing: it must give the recorded verdict (a broken
  chain broken at the same row), the only allowed change being the "two or more U+FFFD" rows above (on SQLite, Node 24
  stores a lone surrogate as U+FFFD). Otherwise nothing is restored. A backup from an older `db:export`, without the
  verdict, restores as before and prints a note.
- `--merge` compares the verdict the same way when the destination has no chained audit rows (an empty log, or only old unchained rows). When it already holds chained rows,
  the merge goes ahead, prints that the audit verdict was not compared, and shows the restored chain's verdict.
- `--allow-audit-change` restores even when the verdict changed (a plain restore, or a `--merge` into an empty audit
  log). It prints both verdicts, before (the backup's) and after (the restored chain's), and ends with a `WARNING`
  line. Use it for a backup you know is broken (for example one taken on Node 20 and restored on Node 24), and keep
  the backup file as the record.

```bash
pnpm --filter @ai-orchestrator/api db:export -- --out backup.json
pnpm --filter @ai-orchestrator/api db:import -- --in backup.json --yes
```

## Running more than one instance

Every feature works on Postgres, and several API instances can share one Postgres database. **Running more than one instance needs `HA_ENABLED=true` on every instance.** Without it (the default) each instance is its own leader, with no lock and no lock connection: right for one instance, but with several, every instance runs every schedule and trigger.

**One leader.** Instances that run background work (`WORKER_MODE=all`, the default, or `worker`) elect one leader with a Postgres advisory lock held on a dedicated connection when `HA_ENABLED=true`. Only the leader runs schedules, polling and app triggers, approval timeouts, the stuck-job sweep of the queue, and the recovery of interrupted resumes. The other instances serve the API and webhooks as usual. A schedule or trigger saved through any instance reaches the leader within 15 seconds, and a trigger always runs the workflow as it is when it fires (the published version when there is one).

**Failover.** One session holds the lock at a time. Postgres frees it when that session ends: the process stops or crashes, or the connection is killed. The leader checks its lock connection every `HA_RENEW_INTERVAL_MS` (default 10 seconds) and stops its leader work as soon as the connection fails, within one check. Another instance takes the lock at its next check. The lock connection also runs a liveness query every renew interval on its own timer, so it is never idle for three renew intervals, even while a slow leader start-up (reconciling runs, loading every schedule) is still running; if the lock is lost during that start-up, the work it started is stopped as soon as it finishes, and an instance that is not the leader never keeps schedules or triggers running. After the leader's host or network is lost without closing the connection, the server ends the old session once it has been idle for three renew intervals (30 seconds by default, `idle_session_timeout`, PostgreSQL 14 or later) or its TCP keepalives give up; with the defaults another instance leads within about 40 seconds. A lone instance whose connection drops tries for the lock again at once. A graceful stop stops the leader's work before it frees the lock.

**Connect the leader directly or through a session-mode pooler.** The lock belongs to a database session. With transaction pooling (for example PgBouncer `pool_mode=transaction`), the lock lands on a server connection other clients reuse, so two instances could both believe they lead, and the store's `search_path` option is lost too. The leader connection sets two independent liveness guards, and either one alone still frees a lost leader's lock within a few renew intervals. If a server or pooler refuses some of them, the API logs one line per process (not per connection) that says what is lost, and keeps working:

- **Only `idle_session_timeout` refused** (PostgreSQL 13 and older): an info line. The TCP keepalives still end a lost leader's session, so another instance takes over within about 50 seconds with the defaults. Only a middlebox that keeps a dead TCP connection open is not covered.
- **Only the TCP keepalive settings refused**: a warning. `idle_session_timeout` still ends a lost leader's session after three renew intervals (about 40 seconds to a takeover with the defaults).
- **Both refused**: a warning. A lost leader's lock is freed only when the server's own keepalive default notices the dead link (about two hours on Linux).

`GET /api/ha/status` (admin only) shows the election as enabled, whether this instance leads, and the holder's `HA_INSTANCE_ID` (set it per instance for readable names; it defaults to the host name plus a random suffix).

**What the database guarantees across instances:**

| What | How |
|---|---|
| A queued job runs on one instance | the claim is `FOR UPDATE SKIP LOCKED` |
| An approval, release request or gate-case request is decided once | a conditional update; the losing decision gets `409` |
| A paused run has one open approval request | a unique index (migration 41) |
| One guard simulation runs at a time | a unique index (migration 39) |
| A webhook idempotency key or replay fingerprint is accepted once | primary keys; a duplicate gets the stored result or `409` |
| Workflow and guard-profile versions get distinct numbers | the parent row is locked while the next number is taken |
| Timeouts expire a request once | the sweep locks rows with `SKIP LOCKED` |

**Restarts.** With a shared database an instance only marks work as interrupted when no instance has touched it recently: runs older than the longest a run may last plus a minute, and eval or replay jobs with no progress for five minutes. A job another live instance is running is left alone.

An approval resume that was interrupted (the instance stopped after the decision was recorded, before the run finished) is picked up again by the leader once its claim is older than `WORKFLOW_EXECUTION_TIMEOUT_MS` plus one minute (`STUCK_JOB_MARGIN_MS`), at the next approval sweep (`APPROVAL_SWEEP_INTERVAL_MS`, default one minute): about 7 minutes after the stop with the defaults, longer if the run timeout is raised, and about two minutes in queue mode (a one-minute claim age). With `HA_ENABLED=true` this holds for a lone instance too, since it cannot tell its own interrupted resume from one another instance is still running. Nothing is lost: the decision stays recorded and the run waits until then. With HA off (one instance, on SQLite or Postgres) the restarted process resumes it at once.

**Upgrading to migration 41.** If a database already holds more than one pending approval request for a run (possible before this release when two instances backfilled the same paused run), the upgrade keeps the newest, cancels the others as "Superseded by a newer request of the same run", and logs the count once at startup. SQLite does the same at its next start.

**Webhook-only replicas** (`WORKER_MODE=webhook`) do not take part in the election and never run background work.
