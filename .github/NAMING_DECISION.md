# Product Name: L2M

**Decision date:** 2026-05-06
**Status:** done. Surface text (README, docs site hero, Why page, CLAUDE.md, VitePress config) moved to L2M on 2026-05-06. The public identifiers moved together in one rename PR on 2026-11-20 (see below). <!-- keep-old-name -->

## The name

**L2M** (written as **L²M**, pronounced "LsquareM") is the product name. The VS Code extension package already uses the name (`apps/vscode-l2m-agent`), and the legacy static site at `docs/integrations.html` already brands the footer as `L²M`.

## Renamed (2026-11-20, one PR)

Repeatable with `node scripts/rename-repo-identifiers.mjs [--dry-run]`; the script prints every change and a second run changes nothing.

- GitHub repository: `TensorGreed/l2m` (README, docs site, VitePress edit links, landing page and JSON-LD, issue templates, CONTRIBUTING, SECURITY, CHANGELOG links, Helm chart, VS Code extension, clone commands `cd l2m`).
- Container images: `ghcr.io/tensorgreed/l2m`, `l2m-web`, `l2m-ner` (release and image-scan workflows, Helm values, docs). No image had been published under the old names.
- Helm chart: [ops/helm/l2m/](../ops/helm/l2m/), chart name `l2m`, template helpers `l2m.*`. No chart had been published; the chart README has the upgrade note (`nameOverride`).
- VS Code extension publisher (Marketplace and Open VSX namespace): `l2m`; extension ID `l2m.vscode-l2m-agent`.
- User-visible labels: the default `MFA_ISSUER` (`L2M`), new nodes' sample texts ("from L2M"), the Grafana dashboard title, the root workspace package name (`l2m`, private), and the AWS ECS example resource names.

## Not renamed (on purpose)

These are internal or are read back by running systems; renaming them churns code and breaks existing installs for no user benefit.

- The `@ai-orchestrator/*` workspace package scope (never published; every import, `pnpm --filter` command and CLAUDE.md command uses it). <!-- keep-old-name -->
- Environment variable names, the SQLite database file name, cookie names, MCP and API token prefixes, code identifiers, and browser storage keys (`ai-orchestrator:*`, which hold users' settings). <!-- keep-old-name -->
- Values read back by running systems: the backup format id (`ai-orchestrator-backup`, needed to import existing backups), the key-derivation salt in the Crypto node (changing it breaks stored ciphertext), the OpenTelemetry default service name and metrics scope (dashboards and alerts query them), the Grafana dashboard `uid`, the MCP `clientInfo` name, the Kafka node's default consumer group, and the git-sync and source-control column defaults. <!-- keep-old-name -->
- File names people may mount or import by path: `ops/nginx/ai-orchestrator.conf` and `ops/grafana/ai-orchestrator-dashboard.json`. <!-- keep-old-name -->
- Test fixtures that replay a third-party export verbatim (`samples/external-imports/apps-dev*.json` and its test).
