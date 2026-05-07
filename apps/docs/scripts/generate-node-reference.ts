/**
 * Generates the per-node reference docs from the canonical
 * `nodeDefinitions` array in packages/shared. Run:
 *
 *   pnpm --filter @ai-orchestrator/docs gen:nodes
 *
 * Output: apps/docs/docs/nodes/reference/<category-slug>.md (one page per
 * NodeCategory) + apps/docs/docs/nodes/reference/index.md.
 *
 * The generated files carry a "DO NOT EDIT BY HAND" banner. Adding a new
 * node only requires a new entry in packages/shared/src/definitions.ts —
 * `pnpm docs:build` regenerates these pages so the docs can't drift from
 * the actual schema.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDefinitions, type NodeDefinition, type NodeCategory } from "@ai-orchestrator/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "docs", "nodes", "reference");

const CATEGORY_ORDER: NodeCategory[] = [
  "Input",
  "LLM",
  "Agent",
  "MCP",
  "RAG",
  "Connector",
  "Utility",
  "Output"
];

const CATEGORY_BLURB: Record<NodeCategory, string> = {
  Input: "Workflow entry points: triggers (cron, webhook, manual, form, chat, MCP-server) and static-input helpers.",
  LLM: "Chat-completion model adapters and prompt-template helpers.",
  Agent: "Tool-calling agent runtimes and the multi-turn memory + artifact stores that back them.",
  MCP: "Model Context Protocol clients and the workflow-as-MCP-tool exposure node.",
  RAG: "Retrieval-Augmented Generation: embedders, vector stores, document loaders, retrievers.",
  Connector: "External system integrations — HTTP, SQL, NoSQL, cloud SDKs, SaaS APIs.",
  Utility: "DAG control flow: branching, looping, merging, sub-workflows, code execution, set/wait.",
  Output: "Terminal nodes that shape the workflow's response payload."
};

function slugify(category: NodeCategory): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  values?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function describeType(prop: Record<string, unknown>): string {
  const t = typeof prop.type === "string" ? prop.type : "";
  if (t === "array") {
    const items = asRecord(prop.items);
    const inner = items ? describeType(items) : "any";
    return `array<${inner}>`;
  }
  return t || "any";
}

function describeValues(prop: Record<string, unknown>): string | undefined {
  const enumValues = asArrayOfStrings(prop.enum);
  if (enumValues.length > 0) return enumValues.map((v) => `\`${v}\``).join(" \\| ");
  return undefined;
}

function fieldRows(configSchema: unknown): FieldRow[] {
  const schema = asRecord(configSchema);
  if (!schema) return [];
  const properties = asRecord(schema.properties) ?? {};
  const required = new Set(asArrayOfStrings(schema.required));
  return Object.entries(properties).map(([name, raw]) => {
    const prop = asRecord(raw) ?? {};
    return {
      name,
      type: describeType(prop),
      required: required.has(name),
      values: describeValues(prop)
    };
  });
}

function renderFieldsTable(rows: FieldRow[]): string {
  if (rows.length === 0) {
    return "_No configurable fields._\n";
  }
  const lines = ["| Field | Type | Required | Values |", "|---|---|---|---|"];
  for (const row of rows) {
    lines.push(
      `| \`${row.name}\` | \`${row.type}\` | ${row.required ? "yes" : "no"} | ${row.values ?? "—"} |`
    );
  }
  return lines.join("\n") + "\n";
}

function renderNodeSection(node: NodeDefinition): string {
  const parts: string[] = [];
  parts.push(`### \`${node.type}\` — ${node.label}`);
  parts.push("");
  parts.push(node.description);
  parts.push("");
  parts.push("**Config fields**");
  parts.push("");
  parts.push(renderFieldsTable(fieldRows(node.configSchema)));
  parts.push("**Example config**");
  parts.push("");
  parts.push("```json");
  parts.push(JSON.stringify(node.sampleConfig, null, 2));
  parts.push("```");
  parts.push("");
  return parts.join("\n");
}

function renderCategoryPage(category: NodeCategory, nodes: NodeDefinition[]): string {
  const sorted = [...nodes].sort((a, b) => a.type.localeCompare(b.type));
  const header = [
    "<!--",
    "  Generated from packages/shared/src/definitions.ts.",
    "  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`",
    "  (or `pnpm docs:build`) to regenerate.",
    "-->",
    "",
    `# ${category} nodes`,
    "",
    CATEGORY_BLURB[category],
    "",
    `${sorted.length} node${sorted.length === 1 ? "" : "s"}.`,
    "",
    "---",
    ""
  ].join("\n");
  return header + sorted.map(renderNodeSection).join("\n---\n\n");
}

function renderIndexPage(byCategory: Map<NodeCategory, NodeDefinition[]>): string {
  const lines: string[] = [
    "<!--",
    "  Generated from packages/shared/src/definitions.ts.",
    "  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`.",
    "-->",
    "",
    "# Node reference",
    "",
    "Auto-generated from the canonical `nodeDefinitions` registry in",
    "`packages/shared/src/definitions.ts`. Every supported node type, every",
    "config field, every default value — kept in lock-step with the running",
    "code by the docs build.",
    "",
    `${nodeDefinitions.length} node types across ${byCategory.size} categories.`,
    "",
    "## Categories",
    ""
  ];

  for (const category of CATEGORY_ORDER) {
    const nodes = byCategory.get(category);
    if (!nodes || nodes.length === 0) continue;
    lines.push(
      `- [${category}](/nodes/reference/${slugify(category)}) — ${CATEGORY_BLURB[category]} (${nodes.length} node${nodes.length === 1 ? "" : "s"})`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const byCategory = new Map<NodeCategory, NodeDefinition[]>();
  for (const node of nodeDefinitions) {
    const list = byCategory.get(node.category) ?? [];
    list.push(node);
    byCategory.set(node.category, list);
  }

  // Wipe any previously-generated files so removing a category propagates.
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith(".md")) fs.rmSync(path.join(OUT_DIR, f));
  }

  let written = 0;
  for (const category of CATEGORY_ORDER) {
    const nodes = byCategory.get(category);
    if (!nodes || nodes.length === 0) continue;
    const filePath = path.join(OUT_DIR, `${slugify(category)}.md`);
    fs.writeFileSync(filePath, renderCategoryPage(category, nodes));
    written++;
    console.log(`  ${path.relative(process.cwd(), filePath)}: ${nodes.length} node${nodes.length === 1 ? "" : "s"}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, "index.md"), renderIndexPage(byCategory));
  console.log(
    `\nWrote ${written} category pages + 1 index covering ${nodeDefinitions.length} node types.`
  );
}

main();
