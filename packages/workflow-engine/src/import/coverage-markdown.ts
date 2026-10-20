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

const CATEGORY_ORDER: ExternalImportCategory[] = ["trigger", "core", "ai"];

const CATEGORY_TITLES: Record<ExternalImportCategory, string> = {
  trigger: "Triggers",
  core: "Core nodes",
  ai: "AI nodes"
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderRows(entries: readonly ExternalImportCoverageEntry[]): string {
  return entries
    .map((entry) => `| \`${escapeCell(entry.sourceType)}\` | \`${entry.targetType}\` | ${escapeCell(entry.notes) || "Direct mapping."} |`)
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
