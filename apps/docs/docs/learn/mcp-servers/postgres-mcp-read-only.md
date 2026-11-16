---
title: "Give an AI agent read-only SQL access over MCP"
sidebarTitle: "Read-only SQL over MCP"
description: "Connect a database to an agent through MCP with a read-only role, statement timeouts, row limits and approvals, so a prompt can't drop a table."
level: intermediate
related: [least-privilege, excessive-agency, write-tool, mcp-tool-policy, approval-gate, prompt-injection]
---

# Give an AI agent read-only SQL access over MCP

To give an agent safe read-only SQL access, make the database enforce it: connect the MCP server as a dedicated role that holds only `SELECT` on the views it needs, with `default_transaction_read_only` and a `statement_timeout` set on that role. A read-only flag inside the MCP server is a second layer, not the boundary, because a server bug or a crafted query can step around it. Then narrow what the agent sees in the client: allow only the query tools, and send anything that writes to a person for approval.

## The reference Postgres server is archived

The original reference PostgreSQL server, `@modelcontextprotocol/server-postgres`, was removed from the `modelcontextprotocol/servers` repository on 2025-05-29 ("Archive unmaintained servers") and now lives in [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived), whose README says it is "archived and no longer maintained" and gives no security guarantees. As of 2026-11, npm marks the package deprecated, and the last published version is still 0.6.2 from December 2024.

That version shows why the database has to do the enforcing. The server had one tool, `query`, which took a `sql` string, ran `BEGIN TRANSACTION READ ONLY`, passed the string to the driver and rolled back. The driver accepts several statements in one string, so input such as `COMMIT; DROP SCHEMA public CASCADE;` ended the read-only transaction and ran the `DROP` with the login's full rights. A fix was merged in [pull request #1889](https://github.com/modelcontextprotocol/servers/pull/1889) ([commit 1f70567](https://github.com/modelcontextprotocol/servers/commit/1f705677a930ec618b7a16d87d00cee7db747ff2)) on 2025-05-29, about two hours before the archive commit landed. It sends the SQL as a named prepared statement, which PostgreSQL parses as a single statement, and destroys the connection after each call instead of returning it to the pool. The fix was never published to npm, and it is not in the archived copy either: the [archived source](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/postgres/index.ts) still passes the string straight to `client.query(sql)`. The fix also added this caution to the README: "If you need to enforce read-only access for security, create a separate database user with only SELECT permissions instead of relying on this server's built-in restrictions."

That advice holds for every SQL MCP server, maintained or not. The rest of this page is the pattern, with PostgreSQL as the example.

## Why the database must be the boundary

OWASP lists this exact case under [LLM06 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/): an extension "intended to read data connects to a database server using an identity that not only has SELECT permissions". Its mitigations include "Minimize extension permissions" and "Complete mediation": implement authorization in downstream systems "rather than relying on an LLM to decide if an action is allowed or not".

A SQL tool is about as open as a tool gets. The agent writes the whole statement, and the statement can come from anything the agent read: a user's message, a document, a web page. <Term id="prompt-injection">Prompt injection</Term> can turn "summarise last week's orders" into a query that reads the `users` table, and a filter in the MCP server that tries to spot bad SQL is a deny-list over a language with comments, casing, CTEs and functions. The database's privilege system is the one place that sees every statement after parsing and knows exactly what each role may touch.

## Set up a read-only role in PostgreSQL

Create a login role for the agent, separate from the application's role. Grant it reads on one schema of views, not on base tables.

```sql
-- 1. A login role with no inherited powers.
CREATE ROLE agent_ro LOGIN PASSWORD 'from-your-secret-store'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5;

-- 2. Remove the defaults PUBLIC gets on the database, then give back only CONNECT.
--    Other roles that relied on PUBLIC need their own GRANT CONNECT too.
REVOKE ALL ON DATABASE analytics FROM PUBLIC;
GRANT CONNECT ON DATABASE analytics TO agent_ro;

-- 3. A schema of views that expose only what the agent needs.
CREATE SCHEMA agent_views;
CREATE VIEW agent_views.orders_last_90d AS
  SELECT id, created_at, status, total_cents, country
  FROM public.orders
  WHERE created_at > now() - interval '90 days';

GRANT USAGE ON SCHEMA agent_views TO agent_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA agent_views TO agent_ro;

-- 4. Seatbelts on the role: read-only by default, short statements.
ALTER ROLE agent_ro SET default_transaction_read_only = on;
ALTER ROLE agent_ro SET statement_timeout = '5s';
ALTER ROLE agent_ro SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE agent_ro SET search_path = agent_views;
```

What each piece does, according to the PostgreSQL 18 documentation:

| Control | What it gives you | Limit to know |
|---|---|---|
| `GRANT SELECT ... ON ALL TABLES IN SCHEMA` | Reads on the tables and views in that schema. "`ALL TABLES` also affects views and foreign tables." | It covers objects that exist when you run it. Re-run it, or use `ALTER DEFAULT PRIVILEGES`, when you add views. |
| Views | Hide columns (no `email`, no `password_hash`) and rows (last 90 days). | A view reads its base table with the view owner's rights (unless created with `security_invoker`), so the agent role needs no grant on `public.orders`. Do not let the agent role own the view. For views that filter rows, add `WITH (security_barrier)`; the [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html) page warns that "not all views are secure against tampering". |
| Column grants | `GRANT SELECT (id, status) ON orders TO agent_ro` limits columns without a view. | Revoking one column after a table-level grant does nothing. The [GRANT](https://www.postgresql.org/docs/current/sql-grant.html) page: "the table-level grant is unaffected by a column-level operation." |
| `REVOKE ... FROM PUBLIC` | By default PUBLIC gets `CONNECT` and `TEMPORARY` on databases, `EXECUTE` on functions and procedures, and `USAGE` on languages and data types. | Check functions too: a `SECURITY DEFINER` function that writes is reachable through `EXECUTE`. |
| `default_transaction_read_only` | Each new transaction starts read-only, so `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `GRANT` and `TRUNCATE` fail. | It is a default. The session can run `SET default_transaction_read_only = off` or `BEGIN READ WRITE`. The grants are the boundary; this catches mistakes. |
| `statement_timeout` | "Abort any statement that takes more than the specified amount of time." | Zero, the default, means no limit. |
| `idle_in_transaction_session_timeout` | Ends a session left idle inside an open transaction. | Protects locks and connections, not data. |
| `CONNECTION LIMIT` | Caps parallel sessions from runaway agents. | Counts sessions, not queries. |

Do not grant the predefined `pg_read_all_data` role to an agent. It reads "all data (tables, views, sequences), as if having `SELECT` rights on those objects and `USAGE` rights on all schemas", which is the opposite of the narrow grant above.

Check the result by logging in as the agent role before you connect anything, for example with `psql -U agent_ro -d analytics`. Log in rather than use `SET ROLE`: settings made with `ALTER ROLE ... SET` apply only at login, so `SET ROLE` would skip them.

```sql
SHOW default_transaction_read_only;                -- on
SELECT count(*) FROM agent_views.orders_last_90d;  -- works
SELECT * FROM public.users LIMIT 1;                -- any table you did not grant: ERROR: permission denied
SET default_transaction_read_only = off;
DELETE FROM agent_views.orders_last_90d;           -- ERROR: permission denied
```

The last two lines are the test that matters. Even with the read-only default turned off, the role cannot write, because it was never granted the right to.

### Row limits

PostgreSQL has no setting that caps how many rows a query returns. Put the cap where you can:

- **In the views.** A view can carry its own `LIMIT` or a time window, as above.
- **In the MCP server.** Many SQL servers have a maximum-rows option. Use it, and read the server's README for its name.
- **Through the timeout.** `statement_timeout` bounds the cost of a full scan even when no row cap applies.

Large results are also a context problem. Ten thousand rows in a tool result cost tokens and push the task out of the model's context. Views that aggregate (`count`, `sum`, grouped by day) usually answer the question better than raw rows.

### Use a replica

For anything near production, point the agent at a hot standby. The PostgreSQL docs say connections there are "strictly read-only; not even temporary tables may be written", and `transaction_read_only` "is always true and may not be changed". A runaway query then slows the replica, not the primary. Long queries on a standby can be cancelled by replay conflicts, which the agent sees as an error and can retry.

## Pick and run a SQL MCP server

With the database locked down, the choice of MCP server matters less. Prefer a maintained server, pin its version, and read its tool list: many SQL servers ship write tools (`execute_sql`, `create_table`) alongside the read ones. Give it a connection string for `agent_ro`, never for the application role.

Run it in a container so the process has no host access. If you start from the **PostgreSQL** preset on L2M's registration form, note that it fills in the archived `@modelcontextprotocol/server-postgres` package without a version, and its note calls the server read-only by design, which the bug above disproves. Replace the command with the maintained server you chose, pinned.

## Attach it to an agent in L2M

L2M treats the server like any other MCP server. Everything below is optional; add what your risk calls for.

**Approve it in the deployment catalog.** The sample catalog in `samples/mcp-catalog.example.json` has a "Data warehouse" entry described as "Read-only SQL over the analytics warehouse". It runs a pinned container image and passes its credentials as environment variables by name:

```json
{
  "id": "warehouse",
  "name": "Data warehouse",
  "description": "Read-only SQL over the analytics warehouse.",
  "adapter": "stdio_mcp",
  "connection": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-e", "WAREHOUSE_API_KEY", "-e", "WAREHOUSE_API_SECRET", "registry.internal/warehouse-mcp:1.4.0"],
    "secretEnvVars": ["WAREHOUSE_API_KEY", "WAREHOUSE_API_SECRET"]
  },
  "requiredSecrets": [
    { "name": "WAREHOUSE_API_KEY", "description": "Service account key id" },
    { "name": "WAREHOUSE_API_SECRET", "description": "Service account secret" }
  ],
  "tags": ["Databases"],
  "approved": true
}
```

The sample entry also has a `notes` field, left out here, that says to store both values as one JSON secret. With `MCP_CATALOG_ENFORCE=true`, admins can register a local server only if its command matches an approved, pinned entry ([deployment catalog](/product/mcp-onboarding#deployment-catalog)). Store the connection credentials in the Secrets store; the value never goes into the connection JSON and the API never returns it ([MCP server registry](/product/mcp-server-registry#registering-a-server)).

**Sandbox it.** Instead of a `docker run` command you maintain yourself, as in the entry above, you can let L2M start the container: set the server's **Sandbox** to **Container** and give it a pinned image. L2M runs `<image> <command> <args>`, so the command is the server's own, not `docker`. If the image sets an entrypoint, the command and arguments are passed to that entrypoint as arguments, so register what the entrypoint expects. The sandbox gives a read-only root filesystem, non-root user, no capabilities and no network unless an admin turns it on for that server ([sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)). A SQL server needs network to reach the database, so turn networking on for this one server only.

**Allow only the read tools.** Write [MCP tool policy](/product/mcp-tool-policy) rules on the registered server: deny `*` on it, then allow the read tools by exact name (`query`, `list_tables`, `describe_table`, whatever your server calls them). The allow is narrower than the deny, so it carves the exception, and a new tool added in a server update stays denied. Denied tools are removed before the model sees the tool set, and every call is checked again.

**Use argument conditions for coarse limits, not for SQL.** If your server takes a `database` or `schema` argument, an allow condition such as `schema one_of ["agent_views"]` is reliable: allow conditions fail closed, so a missing or odd value never widens access ([conditions](/product/mcp-tool-policy#conditions)). A deny rule with `matches "*DROP*"` on the `sql` argument is not: it is case-sensitive unless you tick **Ignore case**, and comments or functions slip past it. Leave SQL text to the database.

**Classify the tool, then decide on approvals.** A tool without annotations counts as a <Term id="write-tool">write tool</Term>. Two optional switches use that:

- **No write tools** blocks every write tool in the workflow and trusts the server's `readOnlyHint` unless an admin marked the tool ([no write tools](/product/mcp-tool-policy#no-write-tools)).
- **Ask before write tools** pauses the run before each write tool call until an approver says yes. It trusts only an admin's mark, never the server's own hint ([approval before write tools](/product/approvals#approval-before-write-tools)).

Mark the query tool read-only on the server's Tools table only after you have run the role check above. The mark is then true because of the database, not because the server says so. If the server also has a write tool you want reachable, leave it as a write tool or add a `require_approval` rule for it, so a person sees the exact SQL before it runs.

**Or skip the agent-written SQL.** When the questions are known in advance, a workflow can run fixed SQL with the **PostgreSQL: Query** node (`postgres_query`, see the [connector reference](/nodes/reference/connector)). It runs the `query` and `params` saved in its config, with the password from a secret reference. It does not check that the SQL is read-only, so give it the same `agent_ro` login. The model never writes SQL on this path; it only reads the rows the node returns.

## Test it without a database

Record the server once, then test the agent against the recording. The steps are in [Test MCP servers in CI](/guides/test-mcp-servers-in-ci); in short:

1. Run the workflow with **Record MCP calls** on (the editor's **⋯** menu). L2M saves each tool call and result in a <Term id="cassette">cassette</Term>, with secrets replaced by `[REDACTED]`.
2. **Replay** the run in `strict` mode after you change the prompt or the workflow. Tool calls are answered from the cassette and strict replay never contacts the server, so the test needs no database. The model is called again, so use a deterministic model setting.
3. Export the server's accepted snapshot and run it as a <Term id="snapshot-mock">snapshot mock</Term> (`l2m mcp mock --snapshot ... --cassette ...`) for offline tests, and run `l2m mcp check` to fail the build on a breaking schema change.

`l2m mcp check` treats an added tool as compatible: it is listed, not failed. That is why the deny-then-allow policy above matters. A write tool that appears in a server update stays denied until someone allows it by name.

Test the database separately. The login check above belongs in your migration checks, so a later `GRANT` that widens the role fails a build too.

## Checklist

- A dedicated login role, no `pg_read_all_data`, no ownership of anything.
- `SELECT` on a schema of views that hide sensitive columns and old rows.
- `default_transaction_read_only = on`, `statement_timeout` and `idle_in_transaction_session_timeout` set on the role.
- A replica for production data.
- A maintained, pinned server in a container, connected as that role.
- Tool policy: deny the server, allow the read tools by name.
- The query tool marked read-only only after the role check passes; approvals for anything else.
- A cassette and a snapshot mock in CI.

## Try it in L2M

The demo's support agent calls two tools, `lookup_kb` and `calculator`, from one registered server, "Demo tools". Open the server's Tools table: both tools are read-only because the server sends `readOnlyHint: true`, not because an admin marked them. That is the same trust a SQL server's own hint asks for. **No write tools** accepts it; **Ask before write tools** does not, and would pause before each call until an admin marks the tool. For a query tool, give that mark only after the role check above passes.

<TryInDemo workflow="wf-demo-support-agent" />

## Further reading

- [Pull request #1889](https://github.com/modelcontextprotocol/servers/pull/1889) and [commit 1f70567](https://github.com/modelcontextprotocol/servers/commit/1f705677a930ec618b7a16d87d00cee7db747ff2) (the unreleased fix for multi-statement queries)
- [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived) and its [src/postgres](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres) (the archived reference servers and the Postgres source, without the fix)
- [Client connection defaults](https://www.postgresql.org/docs/current/runtime-config-client.html), [GRANT](https://www.postgresql.org/docs/current/sql-grant.html), [Privileges](https://www.postgresql.org/docs/current/ddl-priv.html), [Hot standby](https://www.postgresql.org/docs/current/hot-standby.html) (PostgreSQL documentation)
- [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) (OWASP Gen AI Security Project)
- [Least privilege for AI agents](/learn/security/least-privilege-for-agents)
- [MCP tool annotations](/learn/mcp/tool-annotations)
- [MCP tool policy](/product/mcp-tool-policy) and [approval gates](/product/approvals)
