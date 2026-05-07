<!--
Thanks for the PR. Please fill out everything below before requesting review.
For trivial changes (typos, minor docs), feel free to delete sections that
don't apply.
-->

## What and why

<!--
What does this PR change, and why is the change needed?

If this fixes a reported bug, link it: `Fixes #NN`.
If it implements a feature, link the discussion or issue where it was agreed.
-->

## How tested

<!--
Concrete steps you took to verify the change. Not "ran tests" — say which
ones, and what you exercised manually.

Examples:
- pnpm --filter @ai-orchestrator/api test (168/168 pass)
- Manually opened Studio, ran the new sample workflow, confirmed the
  agent calls the new MCP tool and the trace shows up in execution history.
- For UI changes: list the browser, viewport sizes, and edge cases you tried.
-->

## Checklist

- [ ] Code follows the conventions in [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] New / changed logic has tests (`*.test.ts` next to source)
- [ ] `pnpm lint`, `pnpm build`, and `pnpm test` all pass locally
- [ ] User-visible change → entry added under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) (skip for internal refactors / doc-only / CI tweaks)
- [ ] If a node type was added or changed: schema in `packages/shared/src/definitions.ts` + `pnpm --filter @ai-orchestrator/docs gen:nodes`
- [ ] If a DB column / table was added or changed: paired `up`/`down` in `apps/api/src/db/migrations.ts` AND the embedded SQLite schema in `apps/api/src/db/database.ts`
- [ ] If a config knob was added: it's in `.env.example` and zod-validated in `apps/api/src/config.ts`
- [ ] No `TODO` comments, no commented-out code, no debug `console.log`s
- [ ] No emojis in code or commit messages
- [ ] No raw secrets returned from API responses; all secret access goes through `SecretService`

## Screenshots (UI changes only)

<!-- Drag images in. Show before/after if you changed an existing surface. -->

## Breaking changes

<!--
Anything an existing user has to do differently after this lands?
- Workflow JSON contract changes? Bump schemaVersion + describe the migration path.
- Env var renamed or removed? Note the old name and the new behavior.
- API response shape changed? Mention which clients are affected.
-->

None.
