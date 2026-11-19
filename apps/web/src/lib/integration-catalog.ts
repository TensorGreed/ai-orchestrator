/**
 * The integration catalog in the palette: each registered MCP server's tools and each stored OpenAPI spec's
 * operations become palette presets of the MCP Tool or HTTP Request node, labelled `<source> · <item>`.
 */
import type { CatalogPaletteEntry } from "@ai-orchestrator/shared";
import type { PaletteDefinition } from "../components/NodePalette";

/** The palette category the catalog's presets are grouped under. */
export const INTEGRATION_CATALOG_CATEGORY = "Integrations";

/** Palette presets for the catalog's entries (the server builds each node's starting configuration). */
export function catalogPresets(entries: readonly CatalogPaletteEntry[]): PaletteDefinition[] {
  return entries.map((entry) => ({
    presetId: `catalog:${entry.key}`,
    type: entry.nodeType,
    label: entry.label,
    category: INTEGRATION_CATALOG_CATEGORY,
    description: entry.description || (entry.kind === "mcp_tool" ? `Tool of ${entry.sourceName}` : `Operation of ${entry.sourceName}`),
    sampleConfig: entry.nodeConfig
  }));
}

/** Whether a role may use the catalog (add nodes from it, add or refresh APIs). */
export function canUseIntegrationCatalog(role: string | null | undefined): boolean {
  return role === "admin" || role === "builder";
}

/**
 * An MCP Tool node switched to one tool. A node that edits its arguments with the form starts that tool with an empty
 * form: the previous tool's arguments mean nothing to it.
 */
export function withMcpToolChoice(current: Record<string, unknown>, toolName: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, toolName, allowedTools: toolName ? [toolName] : undefined };
  if (current.toolName !== toolName && current.argValues && typeof current.argValues === "object") {
    next.argValues = {};
    next.argsTemplate = "{}";
  }
  return next;
}
