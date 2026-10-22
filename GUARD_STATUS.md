# Guard wiring (Phase 12.1): status checkpoint

Branch `feat/guard-wiring`, based on `origin/main` 95d8563. Main was still at 95d8563 at the last fetch, and its highest migration is 27.

## Done, by brief scope item

1. **Stored, versioned profiles.** CRUD, immutable versions, diff, export and import, field-level errors, and a read-only built-in default. Admins and builders write; operators and viewers read. Implemented in `apps/api/src/services/guard-service.ts` and `apps/api/src/guard-routes.ts`.
2. **Bindings.** Projects bind as inherit, override or enforced (enforced is admin-only); workflows bind as inherit or override. Builders cannot change an enforced binding. Resolution order: enforced first, then the guard port or workflow override or project override, then the instance default when `GUARD_AUTO_APPLY` is on. Every profile in the stack runs and the most severe action wins. The effective profile shows in the UI, in the agent `_guard` trace and in events.
3. **Guard DAG node.** Outputs `pass`, `blocked` and `review`; an unconnected `review` falls back to `blocked`. `require_approval` goes through the approval hand-off (`packages/workflow-engine/src/approval-handoff.ts`).
4. **Agent guard port (0..1).** Hooks the prompt, tool_arguments, tool_result and final_output channels, with spotlighting and canaries, and covers workers.
5. **Protection port (0..N).** Keys come only through `keySecretRef` and SecretService. The token vault lives in `guard_token_vault`, sealed with AES-GCM and purpose-bound. The fallback is deny.
6. **Events and UI.**
   - `guard_events` follows retention and stores masked evidence only.
   - `GuardTracePanel` on the Runs page, a RunTape marker, and a Security page with a nav entry.
   - Profile editor and bindings with the enforced lock (`GuardProfilesView`).
   - Canvas guard and protection slots, and pass / blocked / review handles.
   - Config forms (`GuardNodeConfigFields`), icons and palette entries.
7. **Docs.** `apps/docs/docs/product/guard.md`, the guard-engine page updated (OWASP table kept), the endpoint reference, CHANGELOG, and roadmap §12.1, §12.2, §12.3, §12.5 and §12.7.

**Tests.**
- shared, guard-sdk, engine (`guard.test.ts`, including the e2e corpus indirect-injection test) and agent-runtime.
- api: `guard.test.ts` covers the migration 28 DDL, the SQLite tables, RBAC, masking and the vault. `guard-node-esm.test.ts` is a regression test for Node ESM loading.
- web: `guard-trace`, `guard-profile-edit`, `stages.guard`, `GuardUi` and `GuardCanvasNode`.

## Fixed in this WIP commit

`packages/guard-sdk/src/detectors/sql-guard.ts` imported `{ Parser }` from the CommonJS package `node-sql-parser`. Under Node ESM (`pnpm start` / `tsx`), that crashed the API at startup. Vitest hid the problem. The import now resolves the default export first, and `apps/api/src/guard-node-esm.test.ts` (with the fixture `src/fixtures/guard-esm-smoke.mts`) covers it.

## Security review fixes

From the branch security review (findings numbered as in that review):

1. Fixed. Builders get `403` on PUT or import of a profile any project enforces (`guard-routes.ts`, `refuseEnforcedEdit`).
2. Fixed. Granted approval keys live in `WorkflowExecutionState.approvedHandoffKeys`, written only by the resume path; `__`-prefixed keys are dropped from run input and variables (`approval-handoff.ts`, `executor.ts`).
3. Fixed. The error-handler run gets `guardService.runtimeFor(...)`. The only other engine entry in the API is the main runner, which already had it. Sub-workflows reuse the caller's guard (documented).
4. Fixed. Pattern detectors use `scrubbedExcerpt` (`dlp.ts`): URL query and fragment dropped, SQL literals blanked, DLP hits masked; the SQL parse-error text is scrubbed too.
5. Fixed. Project binding GET/PUT and `/api/guard/effective?projectId=` check project permissions (`canInProject`).
6. Fixed (cheap part). Events, stats, per-execution events and a profile's listed bindings are limited to readable workflows and projects. Documented: profiles are instance-wide and run history is role-only.
7. Fixed. The key covers the tool name and a hash of the masked evidence, and is cleared once the re-run node completes.
8. Fixed. A failed call's error text is guarded on `tool_result` (untrusted_external) and spotlit; a non-object argument rewrite is refused; the failure path caches the rewritten arguments. The success path already cached the rewritten arguments.
9. Documented (egress is advisory for MCP; enforce at the network).
10. Fixed (cheap part): 256-character cap and nested-quantifier refusal, skipped at scan time too. Documented: overlapping alternations and the lack of a regex timeout.
11. Documented.
12. Documented. The cheap fix was already there: `token-vault.ts` refuses deterministic keys shorter than 16 bytes.

Regression tests: `guard-sdk/src/detectors/evidence-scrub.test.ts` and `dlp.test.ts`, `workflow-engine/src/guard.test.ts` (forged keys, key binding), `agent-runtime/src/guard-hooks.test.ts` (failed calls), `api/src/guard.test.ts` ("guard security review fixes").

## Verification so far

- Before the sql-guard fix, the full `pnpm test` passed. Counts:
  - shared 20, guard-sdk 157, mcp-sdk 179, web 317, agent-runtime 28, cli 11
  - workflow-engine 438 (plus 1 web-browse test that was already skipped on main)
  - api 445, vscode extension 20
- `pnpm build` and `pnpm lint` exited 0 before that fix.
- After the sql-guard fix and the security review fixes, `pnpm test`, `pnpm build` and `pnpm lint` all pass. Counts: shared 20, guard-sdk 162, mcp-sdk 179, web 317, agent-runtime 31, cli 11, workflow-engine 440 (plus 1 skipped), api 451, vscode extension 20.
- The SQLite upgrade was checked: a DB created with main's store (65 tables) was copied and opened with this branch's store. The five guard tables were added, the existing data was kept, and a profile write survived a reopen.
- A demo through the real API (temp DB) produced real verdicts: intake runs that pass, block, go to review and mask; agent runs where the injected tool_result was blocked and the card in the answer was masked.

## Left, in order

1. Visual check, not done. Take dark and light screenshots at 1440 and 390 px, and check `scrollWidth <= innerWidth`. Use the localStorage keys `l2m:welcome-dismissed=1` and `ai-orchestrator:theme`. Cover:
   - the guard node on the canvas
   - the agent guard and protection slots
   - the run trace with verdicts
   - the Security page
   - the profile editor with the enforced binding
2. Write the uncommitted `PR_BODY.md` (carry the documented limits from the Guard page's "Limits and deployment notes") with the required title and sections, then fold or squash this WIP commit as wanted.

## Design decisions

- **Guard port model.** The port is a Guard node attached from an agent through the `guard` source handle. A port-attached guard cannot have DAG edges (validation error `guard_port_on_dag`).
- **Protection.** Providers attach from a Guard node through the `protection` handle.
- **Enforcement.** Enforced profiles are always evaluated first, so an override can only tighten.
- **Git sync.** Not included. JSON export and import cover it for now; the PR must say so.
- **Migration.** Number 28, for guard_profiles, guard_profile_versions, guard_bindings, guard_events and guard_token_vault. PostgresStore has DDL only (no guard store methods), the same as the mcp cassettes.
- **Egress resolution.** The engine's default registry uses the system DNS resolver for the egress guard.

## Resume

1. Run `export PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH && pnpm install && pnpm test && pnpm build && pnpm lint`.
2. For the visual check, use the demo harness in `/tmp/l2m-guard-a58/demo` (outside the repo; recreate it if it is gone):
   - `boot.mts` starts the API on 4800, using `apps/api/node_modules/.bin/tsx` and a temp DB, plus fake model and MCP endpoints.
   - `seed.mts` / `seed2.mts` seed profiles, the enforced binding, two workflows and runs.
   - Start vite with `API_PORT=4800 pnpm --filter @ai-orchestrator/web exec vite --port 5899 --strictPort`.
3. Take the screenshots with Playwright into `/tmp/l2m-guard-a58/guard-shots/`, then stop the servers.

## Security areas to review

- Egress DNS resolution at check time (TOCTOU / DNS rebinding).
- Token vault sealing and its AAD purpose binding.
- Event masking: messages carry host and table names only.
- Guard events are scoped to readable workflows; profiles are instance-wide.
- The paused approval state holds the rewritten pass output.
