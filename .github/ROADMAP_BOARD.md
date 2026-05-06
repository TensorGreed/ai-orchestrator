# Public Roadmap Board — One-Time Setup

This is a **one-time setup** by a repo admin. It creates a public [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects) board (a Kanban-style To Do / In Progress / Done view) so contributors and users can see what's planned, in flight, and done without reading internal markdown files. The board is optional — skip if maintaining it is not worth the overhead.

Once it exists, link it from [README.md](../README.md) (replace the "Status and roadmap" placeholder) and from [apps/docs/docs/why.md](../apps/docs/docs/why.md).

## Where to run these commands

Run them from the **repo root** (`ai-orchestrator/`). The `--owner TensorGreed` flag makes `gh project ...` calls work from anywhere, but `gh issue create` defaults to the current repo, so being in the repo folder is the path of least friction.

## Prerequisites

```bash
gh auth login --scopes "repo,project,read:org"
gh auth status   # confirm "Logged in to github.com as <admin>"
```

## 1. Create the project

```bash
gh project create \
  --owner TensorGreed \
  --title "L2M GA roadmap" \
  --format json
```

Capture the returned `number` (e.g. `5`); it identifies the project for every later command. Replace `<PROJECT_NUMBER>` below.

## 2. Add the GA roadmap phases as project items

Each phase becomes a tracking issue, then the issue is added to the project. The phase list mirrors the GA plan; sub-task tracking happens in child issues created later.

```bash
PHASES=(
  "Phase 0 — Repositioning (README hero, docs landing, Why page, project board)"
  "Phase 1 — MCP moat deepening (registry UI, probe/inspector, stdio transport, swarm visualization)"
  "Phase 2 — First-run UX (welcome modal, self-contained samples, dependency badges, field help, friendly errors, gallery thumbnails)"
  "Phase 3 — VS Code agent GA (Marketplace + Open VSX publication, vsce CI artifact)"
  "Phase 4 — Production hardening (rate limit, helmet, multi-stage Docker, Helm PVC, image build CI, request IDs, migration rollback, integration tests, backup CLI)"
  "Phase 5 — Docs & evangelism (5-min MCP tutorial, per-node reference, pattern library, samples repo, contributor guide, changelog)"
  "Phase 6 — Community node SDK (l2m-nodes-* package format, loader, install UI, scaffold, MCP-server packaging path)"
  "Phase 7 — Differentiation deepening (eval framework, workflow-as-tool, time-travel debug, inline cost telemetry)"
)

for phase in "${PHASES[@]}"; do
  gh issue create \
    --title "$phase" \
    --body "Tracking issue for this phase. Sub-tasks tracked in child issues." \
    --label "roadmap" \
    --assignee "@me"
done
```

Then bulk-add every newly-created issue to the project:

```bash
gh issue list --label roadmap --json number --jq '.[].number' | while read num; do
  gh project item-add <PROJECT_NUMBER> --owner TensorGreed --url "https://github.com/TensorGreed/ai-orchestrator/issues/$num"
done
```

## 3. Add a Phase custom field

The defaults give you `Title`, `Status`, `Labels`, `Assignees`. Add `Phase` so the board can group by phase rather than just by status:

```bash
gh project field-create <PROJECT_NUMBER> --owner TensorGreed \
  --name "Phase" \
  --data-type "SINGLE_SELECT" \
  --single-select-options "Phase 0,Phase 1,Phase 2,Phase 3,Phase 4,Phase 5,Phase 6,Phase 7"
```

Set per-item values via the GitHub web UI (faster than scripting eight `gh project item-edit` calls).

## 4. Make the project public and link it

```bash
gh project edit <PROJECT_NUMBER> --owner TensorGreed --visibility PUBLIC
```

Then update two files with the project URL (`https://github.com/orgs/TensorGreed/projects/<PROJECT_NUMBER>`):

- [README.md](../README.md) — paste the public URL into the "Status and roadmap" section, replacing "link forthcoming".
- [apps/docs/docs/why.md](../apps/docs/docs/why.md) — same: replace "link forthcoming" near the end of the page.

## Maintenance

- New work items go into the project as issues, then get a `Phase` value.
- Closing the issue moves it to Done in the board automatically.
- The board is for *active* work; long-lived strategy lives in the GA plan.
