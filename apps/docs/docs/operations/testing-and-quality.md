# Testing and Quality Gates

## Monorepo gates

Run before merge/release:

```bash
pnpm lint
pnpm test
pnpm build
pnpm docs:build
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
- Web unit/component tests in `apps/web`
- Playwright golden-journey E2E in `apps/web/e2e`

## Focused suites

Run only workflow-engine tests:

```bash
pnpm --filter @ai-orchestrator/workflow-engine test
```

Run only web unit/component tests:

```bash
pnpm --filter @ai-orchestrator/web test
```

Run only web E2E:

```bash
pnpm --filter @ai-orchestrator/web e2e
```

The workflow-engine suite includes parser cases for:

- strict rejection of non-JSON payloads
- lenient repair of JSON-like payloads
- anything-goes key-value parsing
- prose + JSON extraction
- nested + moustache input path resolution

The web E2E suite currently covers:

- login/auth gate
- create workflow from dashboard
- configure node and save workflow
- execute workflow and inspect run history
- create secret via UI
- use template from gallery
- human approval journey through approvals APIs
