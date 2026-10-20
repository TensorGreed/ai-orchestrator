# External workflow import fixtures

Source exports from an external visual workflow builder (top-level `nodes[]`,
`connections{}`, `settings`, `pinData`) used by the external workflow import
converter in `packages/workflow-engine/src/import/external-builder.ts`.

Each `<name>.json` is a source export. Each `<name>.expected.json` is the
converter's golden output (`{ workflow, report }`) and is compared verbatim by
`packages/workflow-engine/src/import/external-builder.test.ts`, which also
checks that every converted workflow passes `validateWorkflowGraph`.

| Fixture | Covers |
|---|---|
| `webhook-http-set` | Webhook trigger, HTTP request with query/header/auth, field assignments, pinned data, tags |
| `if-two-branches` | Manual trigger, IF with two output branches, sticky note, no-op, JSON body expressions |
| `switch-three-outputs` | Switch with three renamed outputs plus fallback, merge by field, stop and error |
| `ai-agent-tools` | Chat trigger, AI agent with chat model, memory, two MCP tools and a structured output parser |
| `schedule-code-execute` | Schedule trigger, JavaScript code, wait, execute workflow, split out, sort, limit, aggregate |
| `unsupported-and-odd-expressions` | Unsupported nodes as disabled placeholders, untranslatable expressions, `$env`/`$vars`, extra triggers, Python code, filter |

After an intentional converter change, regenerate the goldens and review the diff:

```bash
UPDATE_EXTERNAL_IMPORT_GOLDENS=1 pnpm --filter @ai-orchestrator/workflow-engine exec vitest run src/import/external-builder.test.ts
```
