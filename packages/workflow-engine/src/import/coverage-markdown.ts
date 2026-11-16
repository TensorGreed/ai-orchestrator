/**
 * Renders the external workflow import coverage table as Markdown.
 *
 * The docs page "Importing a workflow from another builder" includes the
 * generated file, and a test keeps the checked-in copy in sync with the
 * converter's registration table. Regenerate with:
 *
 *   pnpm --filter @ai-orchestrator/workflow-engine gen:import-coverage
 */
import { EXTERNAL_IMPORT_COVERAGE, type ExternalImportCategory, type ExternalImportCoverageEntry } from "./external-builder.js";

const CATEGORY_ORDER: ExternalImportCategory[] = ["trigger", "core", "ai", "app"];

const CATEGORY_TITLES: Record<ExternalImportCategory, string> = {
  trigger: "Triggers",
  core: "Core nodes",
  ai: "AI nodes",
  app: "App nodes"
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * The source type as the public table shows it: without the vendor's package prefix. Types from the core package
 * (`<vendor>-nodes-base.webhook`) show as the bare type (`webhook`); types from another node package
 * (`@<vendor>/<vendor>-nodes-langchain.agent`) keep the package's short name (`langchain.agent`). The registration
 * table and the importer keep the full ids.
 */
export function publicSourceType(sourceType: string): string {
  const match = /^(?:@[^/]+\/)?[^./]*-nodes-([^./]+)\.(.+)$/.exec(sourceType);
  if (!match) return sourceType;
  const [, packageName, type] = match;
  return packageName === "base" ? type! : `${packageName}.${type}`;
}

function renderRows(entries: readonly ExternalImportCoverageEntry[]): string {
  return entries
    .map((entry) => `| \`${escapeCell(publicSourceType(entry.sourceType))}\` | \`${entry.targetType}\` | ${escapeCell(entry.notes) || "Direct mapping."} |`)
    .join("\n");
}

export function renderExternalImportCoverageMarkdown(): string {
  const sections = CATEGORY_ORDER.map((category) => {
    const entries = EXTERNAL_IMPORT_COVERAGE.filter((entry) => entry.category === category);
    return [
      `### ${CATEGORY_TITLES[category]}`,
      "",
      "| Source node type | L2M node | Notes |",
      "|---|---|---|",
      renderRows(entries)
    ].join("\n");
  });

  return [
    "<!-- DO NOT EDIT BY HAND. Generated from the external workflow import registration table by",
    "     `pnpm --filter @ai-orchestrator/workflow-engine gen:import-coverage`. -->",
    "",
    ...sections.flatMap((section) => [section, ""]),
    `Any other source node type is imported as a disabled \`noop_node\` placeholder that keeps the original parameters, so the workflow still loads and validates.`,
    ""
  ].join("\n");
}
