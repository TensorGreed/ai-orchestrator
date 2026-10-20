import type { ImportReport, ImportReportNodeEntry } from "@ai-orchestrator/shared";

/** What a dropped or picked JSON file looks like. */
export type ImportFileFormat = "native" | "external" | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeShape(value: Record<string, unknown>): boolean {
  return Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/**
 * Tells an L2M export (nodes + edges, optionally wrapped in `{ workflow }`)
 * apart from another builder's export (nodes + a `connections` map).
 */
export function detectImportFormat(value: unknown): ImportFileFormat {
  if (!isRecord(value)) return "unknown";
  if (isNativeShape(value)) return "native";
  if (isRecord(value.workflow) && isNativeShape(value.workflow)) return "native";
  if (Array.isArray(value.nodes) && (isRecord(value.connections) || !("edges" in value))) return "external";
  return "unknown";
}

/** Parses text and detects its format; a parse failure is reported as `unknown` with the message. */
export function inspectImportText(text: string): { format: ImportFileFormat; error?: string } {
  try {
    return { format: detectImportFormat(JSON.parse(text)) };
  } catch (error) {
    return { format: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

/** True when any `{ secretId }` object inside `value` points at `secretId`. */
export function referencesSecret(value: unknown, secretId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => referencesSecret(item, secretId));
  if (!isRecord(value)) return false;
  if (value.secretId === secretId) return true;
  return Object.values(value).some((item) => referencesSecret(item, secretId));
}

/**
 * Returns a copy of `value` where every `{ secretId: fromId }` reference now
 * points at `toId`. The original object is left untouched; when nothing
 * matches the same reference is returned.
 */
export function replaceSecretRefs<T>(value: T, fromId: string, toId: string): T {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const replaced = replaceSecretRefs(item, fromId, toId);
      if (replaced !== item) changed = true;
      return replaced;
    });
    return (changed ? next : value) as T;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "secretId" && item === fromId) {
      next[key] = toId;
      changed = true;
      continue;
    }
    const replaced = replaceSecretRefs(item, fromId, toId);
    if (replaced !== item) changed = true;
    next[key] = replaced;
  }
  return (changed ? next : value) as T;
}

export interface ImportChecklistNode {
  id: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
}

export type ImportChecklistKind = "secret" | "variable" | "expression" | "unsupported";

export interface ImportChecklistItem {
  key: string;
  kind: ImportChecklistKind;
  title: string;
  detail: string;
  /** Mono text shown under the title: an expression, credential type or variable name. */
  code?: string;
  nodeIds: string[];
  resolved: boolean;
  /** Placeholder secret id, for `secret` items. */
  secretId?: string;
}

export interface ImportChecklist {
  items: ImportChecklistItem[];
  resolved: number;
  total: number;
  /** Nodes converted with an approximation, worth a look but not blocking. */
  review: ImportReportNodeEntry[];
}

/**
 * Builds the post-import to-do list from the report and the workflow as it is
 * on the canvas now, so items tick themselves off as the user fixes them.
 */
export function buildImportChecklist(
  report: ImportReport,
  state: { nodes: ImportChecklistNode[]; variables: Record<string, string> }
): ImportChecklist {
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const items: ImportChecklistItem[] = [];

  for (const secret of report.secretsToResolve) {
    const stillUsed = state.nodes.some((node) => referencesSecret(node.config, secret.secretId));
    items.push({
      key: `secret:${secret.secretId}`,
      kind: "secret",
      title: secret.credentialName || secret.credentialType,
      detail: stillUsed ? "Pick a stored secret for this credential." : "Linked to a stored secret.",
      code: secret.credentialType,
      nodeIds: secret.nodeIds.filter((id) => byId.has(id)),
      resolved: !stillUsed,
      secretId: secret.secretId
    });
  }

  for (const name of report.variablesToSet) {
    const value = state.variables[name];
    const resolved = typeof value === "string" && value.trim().length > 0;
    items.push({
      key: `variable:${name}`,
      kind: "variable",
      title: name,
      detail: resolved ? "Value set." : "Give this workflow variable a value.",
      nodeIds: [],
      resolved
    });
  }

  for (const [index, expression] of report.unresolvedExpressions.entries()) {
    const node = byId.get(expression.nodeId);
    const resolved = !node || !JSON.stringify(node.config).includes(expression.expression);
    items.push({
      key: `expression:${expression.nodeId}:${expression.path}:${index}`,
      kind: "expression",
      title: `${node?.label ?? expression.sourceName} · ${expression.path}`,
      detail: resolved ? "Rewritten." : expression.reason,
      code: expression.expression,
      nodeIds: node ? [node.id] : [],
      resolved
    });
  }

  for (const entry of report.nodes) {
    if (entry.status !== "unsupported") continue;
    const node = byId.get(entry.targetNodeId);
    const resolved = !node || node.type !== entry.targetType;
    items.push({
      key: `unsupported:${entry.targetNodeId}`,
      kind: "unsupported",
      title: node?.label ?? entry.sourceName,
      detail: resolved ? "Replaced." : entry.reason,
      code: entry.sourceType,
      nodeIds: node ? [node.id] : [],
      resolved
    });
  }

  const review = report.nodes.filter((entry) => entry.status === "approximated" && byId.has(entry.targetNodeId));
  const resolvedCount = items.filter((item) => item.resolved).length;
  return { items, resolved: resolvedCount, total: items.length, review };
}

/** "6 mapped · 2 approximated · 1 placeholder", skipping zero buckets. */
export function summarizeReport(report: ImportReport): string {
  const parts: string[] = [];
  if (report.summary.mapped) parts.push(`${report.summary.mapped} mapped`);
  if (report.summary.approximated) parts.push(`${report.summary.approximated} approximated`);
  if (report.summary.unsupported) {
    parts.push(`${report.summary.unsupported} placeholder${report.summary.unsupported === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" · ") : "No nodes";
}

const STORAGE_PREFIX = "l2m.importReport.";

/** Keeps the report next to the workflow in this browser so the checklist survives a reload. */
export function rememberImportReport(workflowId: string, report: ImportReport): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + workflowId, JSON.stringify(report));
  } catch {
    // Storage unavailable (private mode, quota): the panel still works for this session.
  }
}

export function recallImportReport(workflowId: string): ImportReport | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + workflowId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImportReport;
    return isRecord(parsed) && Array.isArray(parsed.nodes) && isRecord(parsed.summary) ? parsed : null;
  } catch {
    return null;
  }
}

export function forgetImportReport(workflowId: string): void {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + workflowId);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}
