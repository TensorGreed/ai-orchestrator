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

- `--from sqlite:<path>` is the SQLite file, opened read-only. `--from sqlite` alone uses `DB_SQLITE_PATH`, else
  `apps/api/data/orchestrator.db`. A relative path is relative to `apps/api` (where `pnpm --filter` runs the command).
- `--to postgres` uses the same `DB_POSTGRESDB_URL` / `DB_POSTGRESDB_*` settings as the API, including TLS. They are
  read from the environment and from `.env` / `apps/api/.env` (the environment wins). `DB_TYPE` does not matter here.
- `--dry-run` runs every check and prints the row counts, writing nothing. `--yes` copies.

### Step by step

1. **Upgrade the SQLite file to this build.** db:copy refuses a file whose schema is older than the build running it
   (it names what is missing). Start this build once against the file (`DB_SQLITE_PATH=<path> pnpm --filter
   @ai-orchestrator/api start`, wait until it listens, stop it). A file written by a *newer* build is refused too;
   run db:copy from that build.
2. **Create an empty Postgres database.** db:copy migrates a database with no tables itself, through the same
   migrations the API runs. It refuses a database that holds any user or workflow, or rows the migrations did not put
   there, and one at a different schema version.
3. **Stop the API.** The copy needs downtime: writes made to SQLite after the copy starts are not copied. (db:copy
   reads one consistent snapshot of the file, and while it runs it holds the migrations lock on the target, so an
   API instance started against Postgres waits for it.)
4. **Rehearse:** run db:copy with `--dry-run`. Fix anything it refuses.
5. **Copy:** run it with `--yes`. The whole copy is one transaction: if any table fails, or any check below fails,
   nothing is committed and the target stays as it was (migrated and empty), so you can fix the cause and run it again.
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
  rows. The summary prints both verdicts.

### Audit rows Postgres cannot store exactly

SQLite kept two kinds of character in audit text that Postgres cannot store: U+0000, and lone UTF-16 surrogates
written by older builds. On Postgres each becomes U+FFFD. A row with **one** such character still verifies (the
verifier tries every character it could have been). A row with **two or more** cannot be verified on Postgres: there
are too many combinations to try. db:copy names those rows, and the chain on Postgres reports them as "cannot be
verified" (the rest of the chain is still verified). This is a known limit; keep the SQLite file as their record.
db:copy stops instead if a row would turn *broken* on Postgres.

## Backup and restore

- **Postgres:** use your usual tools (`pg_dump` / `pg_restore`, or your provider's snapshots).
- **SQLite:** stop the API and copy the file, or use `db:export`.
- `db:export` / `db:import` write and read a JSON backup of the main tables on either store (`--exclude-history` skips
  execution history and the audit log). A backup restores into the same kind of store it came from: to move from
  SQLite to Postgres, use db:copy. Secrets stay encrypted in the backup; `db:import --source-master-key` re-encrypts
  them when the master key changed.

```bash
pnpm --filter @ai-orchestrator/api db:export -- --out backup.json
pnpm --filter @ai-orchestrator/api db:import -- --in backup.json --yes
```

## Running more than one instance

Several API instances can share one Postgres database; this section describes what that takes.
