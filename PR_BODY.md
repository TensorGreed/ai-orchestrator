# MCP testing: record and replay, snapshot mock servers, l2m mcp check

Phase 10.8 of the roadmap: the three testing and reliability items, end to end (shared types, SDK, engine, API, migration, web, CLI, docs).

## What's in it

### Record and replay
- **Cassettes.** `packages/mcp-sdk/src/cassette.ts` wraps every adapter of a registry for one run (`createRecordingRegistry`) and records, in order: `initialize` capabilities, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list` and `prompts/get`, plus the sampling and elicitation exchanges each tool call triggers. Each entry has the server key, method, name, scrubbed args, `argsHash`, result or error, `at` (ms since recording started) and `durationMs`. Format `l2m.mcp-cassette` v1, zod schema in `packages/shared/src/mcp-testing.ts`, `llm: "not_recorded"`.
- **Server identity.** `registry:<id>` for registry servers, `inline:<adapter>:<12-hex hash of endpoint/url/command/args>` for inline ones. Connections are never stored. The accepted snapshot hash goes next to each registry server.
- **Scrubbing, before anything is kept.** The resolved secret value (every value of a secret bundle), credential-named header and env values from the connection, values under credential-named keys, token-shaped strings (bearer, `sk-`, `ghp_`, `github_pat_`, `xox*`, `glpat-`, `AKIA`, `AIza`, `ya29.`, JWTs) and elicitation answers to sensitive fields (credential-named, or `format: password`, `writeOnly`, `sensitive`/`x-sensitive`) become `[REDACTED]`. The API also runs the SecretService redaction over strings. OAuth tokens never reach the recorder (they live in the adapter's header injection).
- **Limits.** `MCP_CASSETTE_MAX_BYTES` (default 5 MiB) and `MCP_CASSETTE_MAX_CALLS` (default 5000), validated in `config.ts` and listed in `.env.example`. Going over marks the cassette `truncated`; the run is not affected.
- **Storage.** `mcp_cassettes` (SQLite in `database.ts`, Postgres migration **26** in `migrations.ts` with a down migration). Cassettes are deleted with their workflow and pruned with execution history retention.
- **Replay** (`createReplayRegistry`, `McpCassettePlayer`). Matching key: server key + method + name + SHA-256 of the canonical scrubbed args. Identical calls are answered in recorded order; different keys may interleave (parallel DAG branches). List methods can be answered any number of times.
  - `strict` (default): a miss throws `McpCassetteMissError`; never contacts a server. Because agents catch tool errors and carry on, the API also turns a strict replay with any unmatched call into an `error` run (`applyReplayOutcome`) and reports every miss in `mcpReplay.unmatched`.
  - `lenient` (opt-in): an exhausted identical call reuses its last answer; an unseen call goes to the live registry, counted in `mcpReplay.live`.
  - Replay registries register replay adapters for every live adapter id plus the cassette's, so the engine is untouched: it keeps calling `mcpRegistry.get(serverId)`.
- **API.** `record: true` on `/execute` and `/execute/stream` (result gets `mcpCassette`), `POST /api/executions/:id/replay` (`{ mode?, cassetteId? }`, builder, trigger type `mcp_replay`, `customData.mcpReplay`, result gets `mcpReplay`), `POST /api/eval/runs` gains `record` and `replay: { evalRunId | cassetteId, mode }`, `GET /api/eval/runs` gains `mcpCassettes`, `GET /api/executions` items gain an `mcpCassette` badge. Cassette routes `GET /api/mcp/cassettes`, `GET /api/mcp/cassettes/:id`, `GET /api/mcp/cassettes/:id/export` (builder) and `DELETE /api/mcp/cassettes/:id` (admin, audit `mcp_cassette.deleted`). OpenAPI updated.
- **Web.** Editor ⋯ menu **Record MCP calls** (menuitemcheckbox, builders and admins; red dot on the Run pill while on). Runs page cassette badge (opens the viewer) and **Replay** action. New `McpCassetteViewer` (calls in order, discovery calls behind a toggle, arguments and results, error and sampling/elicitation tags, truncated note, "model calls are not recorded" note, Replay / Replay with live fallback / Download / admin Delete). Eval runs get an **MCP calls** fieldset: live, record, or replay a recorded run with optional live fallback. New styles live in `styles/mcp-testing.css` to stay out of `pages.css` and `canvas.css`.

### Snapshot mock servers
- `snapshot_mock` adapter (`packages/mcp-sdk/src/snapshot-mock.ts`), connection `{ sourceServerId | snapshot, cassetteId?, fixedText? }`. The API gives it a snapshot source that loads the **accepted** snapshot (a pending breaking snapshot is skipped back to its predecessor) plus the server's resource and prompt catalog, and cassettes by id.
- `tools/call` order: ajv input validation (an `isError` result on failure) → exact cassette match in order → any recording of the tool → deterministic example from `outputSchema` (as structured content) → fixed text `Mock response from '<tool>' (snapshot <hash12>).`. Resources and prompts come from the catalog, with recorded reads and renders when the cassette has them.
- `GET /api/mcp/servers/:id/snapshot/export` returns an `l2m.mcp-snapshot` v1 file (409 before the first probe).
- Standalone stdio: `serveSnapshotMockOverStdio` (newline JSON-RPC, protocol versions 2025-06-18 / 2025-03-26 / 2024-11-05, diagnostics on stderr only), used by `l2m mcp mock` and by `packages/mcp-sdk/src/bin/snapshot-mock-stdio.ts`.

### `l2m` CLI (`packages/cli`, `pnpm l2m …`)
- `l2m mcp check` against the API (`--api-url`/`--api-key` or `L2M_API_URL`/`L2M_API_KEY`; `--server` (repeatable or comma list), `--toolset`, `--workflow`, `--allow-unreachable`, `--allow-policy-blocked`, `--json`) → `POST /api/mcp/check`.
- `l2m mcp check --snapshot <file>…` offline, against `--stdio "<command>"`, `--url <endpoint>` or `--against <snapshot file>` (breaking changes and reachability; policy needs the API).
- `l2m mcp mock --snapshot <file> [--cassette <file>] [--fixed-text <text>]`.
- `l2m mcp snapshot export --server <id> [--out <file>]`.
- Exit codes: 0 clean, 1 failures or a failed request, 2 usage errors. `judgeMcpCheck` in `packages/shared` is shared by the API and the offline CLI so both judge the same way.
- `POST /api/mcp/check` (builder, works with API keys): probes the selected servers in parallel with `MCP_PROBE_TIMEOUT_MS` **without recording probes or snapshots**, diffs against the accepted snapshot with `diffToolSnapshots`, and evaluates tool policy for every tool a workflow names explicitly (MCP Tool nodes and agent allow lists) as the role that workflow's runs use, with the workflow's project and No write tools setting. A toolset selects its server members plus the servers its workflow members use.

### Docs
- New page `apps/docs/docs/product/testing-mcp-workflows.md` (in the sidebar), endpoint reference section "MCP testing", CHANGELOG entries under the MCP heading, three §10.8 items ticked in the roadmap.

## Design decisions and limits
- **Model calls are not recorded.** Replays call the model again; the docs and the viewer say so and suggest temperature 0 or the `echo` provider for fully deterministic runs.
- **Sampling and elicitation are not re-issued during replay**: the tool call's recorded result already reflects them. They are kept in the cassette for reference only, with sensitive answers scrubbed.
- **Replay uses the current workflow**, so it works as a regression test after edits; a strict replay of a changed workflow fails clearly naming the call.
- **Replay input** is rebuilt from the stored execution input by trigger type (manual / retry / replay / eval / webhook-style). Inputs that were redacted when stored replay as stored.
- **Replay returns 200** with the run result, like `/execute`; a diverged strict replay has status `error` in the body rather than an HTTP error.
- **Who records.** Any role that can run a workflow may send `record: true` (cassettes are scrubbed and only builders and admins can read them); the editor toggle shows for builders and admins. Webhooks, schedules, queue workers and gateway calls are never recorded.
- **Lenient fallback** resolves live servers with the normal registry resolver, so breaking-change blocks, secrets and tool policy still apply to live calls.
- **Postgres store parity.** The Postgres migration (26) is in place and covered by a unit test, but the Postgres store does not implement the MCP tables yet (same as the other Phase 10 MCP tables); that parity is Phase 13.1.
- **Adapter id** for the mock is `snapshot_mock` (matching `http_mcp` / `stdio_mcp`).
- `pnpm lint` is a no-op today (no package defines `lint`); type checks run through `pnpm build`.

## Tests
- `packages/mcp-sdk`: `cassette.test.ts` (12: scrubbing, keys, budget/truncation, recording incl. exchanges, strict/lenient replay, report), `snapshot-mock.test.ts` (8: examples, validation, cassette answers, resources/prompts, registry adapter, stdio process).
- `packages/workflow-engine`: `mcp-cassette.test.ts` (2: agent + direct MCP node recorded then replayed strictly with identical output and no live calls; empty cassette fails strictly).
- `apps/api`: `mcp-testing.test.ts` (6: migration 26; record → badge → cassette routes and RBAC → replay identical output → strict divergence / lenient live fallback → secrets never stored → admin-only delete; truncation; eval record and replay by run and by cassette, bad combinations; snapshot export and a `snapshot_mock` registry server; check endpoint clean / policy-blocked / breaking / unreachable / API key / unknown ids).
- `packages/cli`: `main.test.ts` (11: exit codes for clean, additive, breaking, unreachable and usage errors, `--json`, a live stdio check against the mock of itself, API mode request shape and failures, snapshot export, `l2m mcp mock` answering `initialize`, `tools/list` and `tools/call` over stdio).
- `apps/web`: StudioHud record toggle (2), Runs badge, Replay and viewer (2), `McpCassetteViewer.test.tsx` (3), eval record/replay options (2).

Results: `pnpm test` passes everywhere (web 279, api 422, workflow-engine 414 + 1 skipped, mcp-sdk 130, cli 11, agent-runtime 22, shared 14, provider-sdk 7, vscode 20); `pnpm build` passes (including the docs build); `pnpm lint` passes (no-op).

Visual check against an isolated API and web build: Record toggle in the editor menu, Runs page with cassette badges and Replay, the cassette viewer and the replayed run, and the eval MCP options, in dark and light at 1440 px and 390 px.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
