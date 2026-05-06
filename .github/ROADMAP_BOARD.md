# Public Roadmap Board

**Status:** Live at <https://github.com/orgs/TensorGreed/projects/1> ("L2M GA roadmap"), seeded with the eight GA phases as `roadmap`-labeled tracking issues.

This document captures the one-time setup so contributors who fork this repo (or future maintainers who need to recreate the board) can reproduce it. Day-to-day, just visit the board URL above.

## How it was set up

All commands run from the repo root in PowerShell on Windows (this repo's primary development environment). Admins on macOS/Linux can swap PowerShell-specific syntax for the equivalent bash, but watch out for `\` line continuations and `${...}` expansion.

### Prerequisites

```powershell
gh auth login --scopes "repo,project,read:org"
gh auth status
```

### 1. Create the project

```powershell
gh project create --owner TensorGreed --title "L2M GA roadmap" --format json
```

Capture the returned `number` (here, `1`). Substitute it for `<N>` in subsequent commands.

### 2. Create the `roadmap` label

`gh issue create --label roadmap` will fail if the label doesn't exist on the repo, so create it first:

```powershell
gh label create roadmap --color "5319e7" --description "GA roadmap tracking"
```

### 3. Seed the eight phase tracking issues

```powershell
$phases = @(
  "Phase 0 — Repositioning (README hero, docs landing, Why page, project board)",
  "Phase 1 — MCP moat deepening (registry UI, probe/inspector, stdio transport, swarm visualization)",
  "Phase 2 — First-run UX (welcome modal, self-contained samples, dependency badges, field help, friendly errors, gallery thumbnails)",
  "Phase 3 — VS Code agent GA (Marketplace + Open VSX publication, vsce CI artifact)",
  "Phase 4 — Production hardening (rate limit, helmet, multi-stage Docker, Helm PVC, image build CI, request IDs, migration rollback, integration tests, backup CLI)",
  "Phase 5 — Docs & evangelism (5-min MCP tutorial, per-node reference, pattern library, samples repo, contributor guide, changelog)",
  "Phase 6 — Community node SDK (l2m-nodes-* package format, loader, install UI, scaffold, MCP-server packaging path)",
  "Phase 7 — Differentiation deepening (eval framework, workflow-as-tool, time-travel debug, inline cost telemetry)"
)

foreach ($p in $phases) {
  gh issue create --title $p --body "Tracking issue for this phase. Sub-tasks tracked in child issues." --label roadmap --assignee "@me"
}
```

### 4. Bulk-add the issues to the project

```powershell
gh issue list --label roadmap --json number --jq ".[].number" | ForEach-Object {
  gh project item-add <N> --owner TensorGreed --url "https://github.com/TensorGreed/ai-orchestrator/issues/$_"
}
```

GitHub's API occasionally returns transient `504 Gateway Timeout` for individual `item-add` calls. The operation is effectively idempotent — just re-run the same loop until every issue is in the project. Verify with:

```powershell
gh project item-list <N> --owner TensorGreed --limit 20 --format json | ConvertFrom-Json | Select-Object -ExpandProperty items | Measure-Object
```

### 5. Add a `Phase` custom field for grouping

```powershell
gh project field-create <N> --owner TensorGreed --name "Phase" --data-type "SINGLE_SELECT" --single-select-options "Phase 0,Phase 1,Phase 2,Phase 3,Phase 4,Phase 5,Phase 6,Phase 7"
```

Set per-item Phase values via the GitHub web UI — faster than scripting eight `gh project item-edit` calls.

### 6. Make the project public

```powershell
gh project edit <N> --owner TensorGreed --visibility public
```

## Maintenance

- New work items go into the project as issues with the `roadmap` label, then receive a `Phase` value via the web UI.
- Closing the issue moves it to Done in the board automatically.
- The board is for *active* work; long-lived strategy lives in the GA plan stored outside the public repo.
