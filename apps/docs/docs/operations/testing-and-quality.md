# Testing and Quality Gates

## Monorepo gates

Run before merge/release:

```bash
pnpm -r --if-present build
pnpm -r --if-present test
```

## Current coverage areas

- Workflow engine execution + validation
- Agent runtime loop behavior
- Auth + RBAC APIs
- Secure webhook auth/replay/idempotency behavior
- Azure connector test endpoint flows

## Suggested additional gates

- Playwright UI e2e for editor flows
- Contract tests for provider/connector adapters
- Performance tests for large tool catalogs and large graph executions
