import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";

export type StudioMode =
  | "dashboard"
  | "editor"
  | "templates"
  | "variables"
  | "executions"
  | "approvals"
  | "chat"
  | "evaluations"
  | "knowledge"
  | "mcp"
  | "mcp-servers"
  | "mcp-tools"
  | "mcp-policies"
  | "mcp-toolsets"
  | "mcp-clients"
  | "mcp-ai-routes"
  | "mcp-playground"
  | "mcp-changes"
  | "connections"
  | "security"
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
  // 12.6b — the models served on the OpenAI-compatible /v1 endpoint.
  { mode: "mcp-ai-routes", label: "AI routes", adminOnly: true, section: "mcp" },
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
  // Phase 11.2 — runs waiting on a person, for everyone who can read runs.
  { mode: "approvals", label: "Approvals" },
  // Phase 12.1 — guard verdicts, profiles and bindings; everyone who can read runs.
  { mode: "security", label: "Security" },
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

export type RunStatusState = "idle" | "running" | "waiting" | "ok" | "error";

/** What a run waiting on a person reads as, wherever its status shows (HUD pill, Runs, run tape). */
export const WAITING_FOR_APPROVAL_LABEL = "Waiting for approval";

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
  // One entry per node: a Loop body node has a result per pass and counts once (the validation saw "7 ok" for 6 nodes).
  // A node failed when a pass failed unhandled, was handled when a pass's failure was handled, and so on.
  const byNode = new Map<string, string>();
  const rank: Record<string, number> = { error: 5, handled: 4, running: 3, success: 2, skipped: 1 };
  for (const node of result.nodeResults) {
    const shown = node.status === "error" && node.handled === true ? "handled" : node.status;
    const before = byNode.get(node.nodeId);
    if (before === undefined || (rank[shown] ?? 0) > (rank[before] ?? 0)) byNode.set(node.nodeId, shown);
  }
  const nodeStatuses = [...byNode.values()];
  const skipped = nodeStatuses.filter((status) => status === "skipped").length;
  const total = nodeStatuses.length - skipped;
  // A failure the run handled (routed to its Error output, caught, continued past) counts as ok, and is named.
  const handled = nodeStatuses.filter((status) => status === "handled").length;
  const ok = nodeStatuses.filter((status) => status === "success").length + handled;
  const started = Date.parse(result.startedAt);
  const completed = Date.parse(result.completedAt);
  const duration = Number.isFinite(started) && Number.isFinite(completed) ? formatDuration(completed - started) : null;
  const errors = nodeStatuses.filter((status) => status === "error").length;
  const handledNote = handled > 0 ? ` · ${handled} handled` : "";
  const summary =
    total > 0
      ? ok === total && handled === 0
        ? `${ok} ok`
        : `${ok} of ${total} ok${errors > 0 ? ` · ${errors} failed` : ""}${handledNote}`
      : result.status;
  // A run paused on a Human Approval has not finished: it waits (amber), whatever its nodes did so far.
  if (result.status === "waiting_approval") {
    return { state: "waiting", label: total > 0 ? `${WAITING_FOR_APPROVAL_LABEL} · ${summary}` : WAITING_FOR_APPROVAL_LABEL };
  }
  const label = duration ? `last run ${duration} · ${summary}` : `last run · ${summary}`;
  const failed = result.status === "error" || Boolean(result.error);
  return { state: failed ? "error" : "ok", label };
}
