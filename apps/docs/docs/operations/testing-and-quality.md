# Testing and Quality Gates

## Monorepo gates

Run before merge/release:

```bash
pnpm -r --if-present build
pnpm -r --if-present test
```

## Current coverage areas

- Workflow engine execution + validation
- Output Parser strict/lenient/anything_goes parsing behavior
- Output Parser nested path + moustache input key resolution
- Agent runtime loop behavior
- Agent session tool cache persistence and cache-tool retrieval behavior
- Auth + RBAC APIs
- Secure webhook auth/replay/idempotency behavior
- Azure connector test endpoint flows

## Focused parser regression tests

Run only workflow-engine tests:

```bash
pnpm --filter @ai-orchestrator/workflow-engine test
```

The suite includes parser cases for:

- strict rejection of non-JSON payloads
- lenient repair of JSON-like payloads
- anything-goes key-value parsing
- prose + JSON extraction
- nested + moustache input path resolution

## Suggested additional gates

- Playwright UI e2e for editor flows
- Contract tests for provider/connector adapters
- Performance tests for large tool catalogs and large graph executions
