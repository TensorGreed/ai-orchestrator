import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";

export type StudioMode =
  | "dashboard"
  | "editor"
  | "templates"
  | "variables"
  | "executions"
  | "chat"
  | "evaluations"
  | "knowledge"
  | "mcp"
  | "mcp-servers"
  | "mcp-tools"
  | "mcp-policies"
  | "mcp-toolsets"
  | "mcp-clients"
  | "mcp-playground"
  | "mcp-changes"
  | "connections"
  | "secrets"
  | "settings";

export interface StudioModeItem {
  mode: StudioMode;
  label: string;
  /** Renders only for builders and admins (the users who can manage secrets). */
  adminOnly?: boolean;
  /** Sidebar group; items without one sit in the Workspace list. */
  section?: "mcp";
}

/** Phase 10.3 — the MCP control plane section. Builders and admins see it; admin-only actions stay inside the pages. */
export const MCP_MODE_ITEMS: ReadonlyArray<StudioModeItem> = [
  { mode: "mcp", label: "Overview", adminOnly: true, section: "mcp" },
  { mode: "mcp-servers", label: "Servers", adminOnly: true, section: "mcp" },
  { mode: "mcp-tools", label: "Tools", adminOnly: true, section: "mcp" },
  { mode: "mcp-policies", label: "Policies", adminOnly: true, section: "mcp" },
  { mode: "mcp-toolsets", label: "Toolsets", adminOnly: true, section: "mcp" },
  { mode: "mcp-clients", label: "Clients", adminOnly: true, section: "mcp" },
  { mode: "mcp-playground", label: "Playground", adminOnly: true, section: "mcp" },
  { mode: "mcp-changes", label: "Changes", adminOnly: true, section: "mcp" }
];

export function isMcpMode(mode: StudioMode): boolean {
  return mode === "mcp" || mode.startsWith("mcp-");
}

/** Ordered navigation: the Workspace list, then the MCP section, then Secrets and Settings. */
export const STUDIO_MODE_ITEMS: ReadonlyArray<StudioModeItem> = [
  { mode: "dashboard", label: "Home" },
  { mode: "editor", label: "Editor" },
  { mode: "templates", label: "Templates" },
  { mode: "variables", label: "Variables" },
  { mode: "executions", label: "Runs" },
  { mode: "chat", label: "Chat" },
  { mode: "evaluations", label: "Evaluations" },
  { mode: "knowledge", label: "Knowledge" },
  ...MCP_MODE_ITEMS,
  // Phase 10.7 — every user connects their own accounts to MCP servers that act per person.
  { mode: "connections", label: "My connections" },
  { mode: "secrets", label: "Secrets", adminOnly: true },
  { mode: "settings", label: "Settings" }
];

/** Label used outside the sidebar group (command palette, page titles): "MCP · Tools". */
export function studioModeLabel(item: StudioModeItem): string {
  return item.section === "mcp" ? `MCP · ${item.label}` : item.label;
}

export type RunStatusState = "idle" | "running" | "ok" | "error";

/** Shape the HUD run-status pill renders. App derives it from `busy` + the last execution result. */
export interface RunStatus {
  state: RunStatusState;
  label: string;
}

/** One entry in the command palette. `run` performs the action; the palette closes afterwards. */
export interface CommandPaletteItem {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 s";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${seconds} s`;
}

/** Pure helper: turn App state into the HUD run-status pill. */
export function deriveRunStatus(busy: boolean, result: WorkflowExecutionResult | null | undefined): RunStatus {
  if (busy) {
    return { state: "running", label: "running…" };
  }
  if (!result) {
    return { state: "idle", label: "no runs yet" };
  }
  const skipped = result.nodeResults.filter((node) => node.status === "skipped").length;
  const total = result.nodeResults.length - skipped;
  const ok = result.nodeResults.filter((node) => node.status === "success").length;
  const started = Date.parse(result.startedAt);
  const completed = Date.parse(result.completedAt);
  const duration = Number.isFinite(started) && Number.isFinite(completed) ? formatDuration(completed - started) : null;
  const errors = result.nodeResults.filter((node) => node.status === "error").length;
  const summary =
    total > 0
      ? ok === total
        ? `${ok} ok`
        : `${ok} of ${total} ok${errors > 0 ? ` · ${errors} failed` : ""}`
      : result.status;
  const label = duration ? `last run ${duration} · ${summary}` : `last run · ${summary}`;
  const failed = result.status === "error" || Boolean(result.error);
  return { state: failed ? "error" : "ok", label };
}
