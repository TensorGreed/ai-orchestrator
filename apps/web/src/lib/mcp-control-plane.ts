/**
 * Phase 10.3 — pure helpers for the MCP control plane pages and the canvas
 * markers: labels, tool catalogue filters and sorting, change-feed links and
 * the per-node marker derived from the servers list and the caller's access.
 */

import type { McpCatalogServer, McpCatalogTool, McpChangeItem, McpChangeKind, McpChangeLink, McpServerStatus } from "./api";

/** Where a control-plane link goes. App maps the page to a StudioMode. */
export interface McpNavTarget {
  page: "overview" | "servers" | "tools" | "policies" | "toolsets" | "clients" | "playground" | "changes";
  serverId?: string;
  policyId?: string;
  toolName?: string;
}

export const MCP_STATUS_LABEL: Record<McpServerStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
  unknown: "Not probed"
};

/** Fixed order: worst first, so attention-worthy states lead every list. */
export const MCP_STATUS_ORDER: readonly McpServerStatus[] = ["down", "degraded", "healthy", "unknown"];

export const MCP_CHANGE_KIND_LABEL: Record<McpChangeKind, string> = {
  schema: "Schema",
  acceptance: "Acceptance",
  status: "Status",
  policy: "Policy",
  classification: "Classification",
  toolset: "Toolset",
  client: "Client",
  oauth: "OAuth",
  sampling: "Sampling",
  catalog: "Resources & prompts",
  breaker: "Circuit breaker",
  server: "Server"
};

export const MCP_CHANGE_KINDS: readonly McpChangeKind[] = [
  "schema",
  "acceptance",
  "status",
  "policy",
  "classification",
  "toolset",
  "client",
  "oauth",
  "sampling",
  "catalog",
  "breaker",
  "server"
];

export function changeLinkTarget(link: McpChangeLink | null): McpNavTarget | null {
  if (!link) return null;
  return {
    page: link.page,
    ...(link.serverId ? { serverId: link.serverId } : {}),
    ...(link.policyId ? { policyId: link.policyId } : {}),
    ...(link.toolName ? { toolName: link.toolName } : {})
  };
}

export function changeLinkLabel(link: McpChangeLink | null): string | null {
  if (!link) return null;
  switch (link.page) {
    case "servers":
      return "Open server";
    case "policies":
      return link.policyId ? "Open rule" : "Open policies";
    case "toolsets":
      return "Open toolsets";
    case "clients":
      return "Open clients";
    case "tools":
      return "Open tool";
  }
}

/** Text that goes with a change entry's severity colour; colour never carries the meaning alone. */
export function changeSeverityLabel(item: Pick<McpChangeItem, "severity">): string {
  switch (item.severity) {
    case "breaking":
      return "Breaking";
    case "warning":
      return "Attention";
    case "info":
      return "Info";
    default:
      return "Change";
  }
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatPercent(rate: number): string {
  if (rate <= 0) return "0%";
  if (rate < 0.01) return "<1%";
  return `${Math.round(rate * 100)}%`;
}

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0";
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Tools catalogue
// ---------------------------------------------------------------------------

export type McpToolKindFilter = "any" | "read" | "write";

export interface McpToolFilters {
  search: string;
  serverId: string;
  status: McpServerStatus | "any";
  kind: McpToolKindFilter;
  destructive: boolean;
  openWorld: boolean;
  blocked: boolean;
  outputSchema: boolean;
}

export const EMPTY_TOOL_FILTERS: McpToolFilters = {
  search: "",
  serverId: "",
  status: "any",
  kind: "any",
  destructive: false,
  openWorld: false,
  blocked: false,
  outputSchema: false
};

export function countActiveToolFilters(filters: McpToolFilters): number {
  let count = 0;
  if (filters.search.trim()) count += 1;
  if (filters.serverId) count += 1;
  if (filters.status !== "any") count += 1;
  if (filters.kind !== "any") count += 1;
  for (const flag of [filters.destructive, filters.openWorld, filters.blocked, filters.outputSchema]) if (flag) count += 1;
  return count;
}

export function filterCatalogTools(tools: readonly McpCatalogTool[], filters: McpToolFilters): McpCatalogTool[] {
  const needle = filters.search.trim().toLowerCase();
  return tools.filter((tool) => {
    if (needle) {
      const haystack = `${tool.name} ${tool.annotations?.title ?? ""} ${tool.description ?? ""} ${tool.serverName}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.serverId && tool.serverId !== filters.serverId) return false;
    if (filters.status !== "any" && tool.serverStatus !== filters.status) return false;
    if (filters.kind === "read" && !tool.classification.readOnly) return false;
    if (filters.kind === "write" && tool.classification.readOnly) return false;
    if (filters.destructive && tool.annotations?.destructiveHint !== true) return false;
    if (filters.openWorld && tool.annotations?.openWorldHint !== true) return false;
    if (filters.blocked && tool.access.allowed) return false;
    if (filters.outputSchema && !tool.outputSchema) return false;
    return true;
  });
}

export type McpToolSortKey = "name" | "server" | "calls" | "errors" | "p95" | "cost";

function sortValue(tool: McpCatalogTool, key: McpToolSortKey): number | string | null {
  switch (key) {
    case "name":
      return tool.name.toLowerCase();
    case "server":
      return tool.serverName.toLowerCase();
    case "calls":
      return tool.telemetry?.calls ?? 0;
    case "errors":
      return tool.telemetry?.errors ?? 0;
    case "p95":
      return tool.telemetry?.p95Ms ?? null;
    case "cost":
      return tool.telemetry?.costUsd ?? null;
  }
}

/** Sorts a copy. Missing numbers (no calls, no price) always sort last. Ties fall back to name, then server. */
export function sortCatalogTools(tools: readonly McpCatalogTool[], key: McpToolSortKey, direction: "asc" | "desc"): McpCatalogTool[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...tools].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== null && right !== null && left !== right) return left < right ? -sign : sign;
    return a.name.localeCompare(b.name) || a.serverName.localeCompare(b.serverName);
  });
}

export function toolKey(tool: Pick<McpCatalogTool, "serverId" | "name">): string {
  return `${tool.serverId}::${tool.name}`;
}

// ---------------------------------------------------------------------------
// Canvas markers
// ---------------------------------------------------------------------------

export type McpPolicyState = "blocked" | "destructive" | "write" | "read_only";

/** What an MCP Tool node shows on the canvas about its registered server. */
export interface McpCanvasMarker {
  serverId: string;
  serverName: string;
  status: McpServerStatus;
  statusLabel: string;
  breakingPending: boolean;
  /** Phase 10.7 — the server's circuit breaker is open (calls refused) or half-open (one trial call). */
  circuit: "open" | "half_open" | null;
  /** Worst policy state for the current user across the tools the node uses; null when unknown (no snapshot yet). */
  policy: McpPolicyState | null;
  /** Rule that blocks the tool (single tool) or the first blocking rule (all tools). */
  blockingRuleId: string | null;
  blockingRuleName: string | null;
  /** Tools of the node blocked for the user, out of how many it can use. */
  blockedCount: number;
  toolCount: number;
  /** Text for the tooltip and the accessible name. */
  description: string;
}

/** Registry server id an MCP Tool node points at, if any. */
export function registryServerIdOf(config: Record<string, unknown> | undefined): string | null {
  const value = config?.registryServerId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nodeToolNames(config: Record<string, unknown>): string[] | null {
  const toolName = typeof config.toolName === "string" ? config.toolName.trim() : "";
  if (toolName && toolName !== "__all__") return [toolName];
  const allowed = Array.isArray(config.allowedTools) ? config.allowedTools.map((tool) => String(tool ?? "").trim()).filter(Boolean) : [];
  return allowed.length > 0 ? allowed : null;
}

const POLICY_RANK: Record<McpPolicyState, number> = { read_only: 0, write: 1, destructive: 2, blocked: 3 };

const POLICY_TEXT: Record<McpPolicyState, string> = {
  blocked: "blocked for you by policy",
  destructive: "destructive tool",
  write: "write tool",
  read_only: "read-only"
};

export function policyStateOf(tool: Pick<McpCatalogTool, "access" | "classification" | "annotations">): McpPolicyState {
  if (!tool.access.allowed) return "blocked";
  if (tool.annotations?.destructiveHint === true) return "destructive";
  return tool.classification.readOnly ? "read_only" : "write";
}

export function deriveCanvasMarker(
  config: Record<string, unknown> | undefined,
  servers: ReadonlyMap<string, Pick<McpCatalogServer, "id" | "name" | "status" | "pendingBreakingSnapshotId" | "breakerState">>,
  toolsByServer: ReadonlyMap<string, readonly McpCatalogTool[]>
): McpCanvasMarker | null {
  const serverId = registryServerIdOf(config);
  if (!serverId) return null;
  const server = servers.get(serverId);
  if (!server) return null;
  const names = nodeToolNames(config ?? {});
  const serverTools = toolsByServer.get(serverId) ?? [];
  const used = names ? serverTools.filter((tool) => names.includes(tool.name)) : serverTools;

  let policy: McpPolicyState | null = null;
  let blocking: McpCatalogTool | null = null;
  let blockedCount = 0;
  for (const tool of used) {
    const state = policyStateOf(tool);
    if (state === "blocked") {
      blockedCount += 1;
      blocking ??= tool;
    }
    if (policy === null || POLICY_RANK[state] > POLICY_RANK[policy]) policy = state;
  }
  // "All tools" with only some blocked is still usable: show the worst usable state and count the rest.
  if (!names && policy === "blocked" && blockedCount < used.length) {
    policy = used
      .filter((tool) => tool.access.allowed)
      .map(policyStateOf)
      .reduce<McpPolicyState>((worst, state) => (POLICY_RANK[state] > POLICY_RANK[worst] ? state : worst), "read_only");
  }

  const statusLabel = MCP_STATUS_LABEL[server.status];
  const parts = [`${server.name}: ${statusLabel}`];
  if (server.pendingBreakingSnapshotId) parts.push("breaking change pending");
  const circuit = server.breakerState === "open" || server.breakerState === "half_open" ? server.breakerState : null;
  if (circuit === "open") parts.push("circuit open: calls are paused after repeated failures");
  if (circuit === "half_open") parts.push("circuit half-open: trying one call");
  if (policy) {
    if (policy === "blocked") {
      parts.push(names && names.length === 1 ? POLICY_TEXT.blocked : `all ${used.length} tools blocked for you by policy`);
    } else {
      parts.push(names && names.length === 1 ? POLICY_TEXT[policy] : `uses ${policy === "read_only" ? "read-only" : `${POLICY_TEXT[policy]}s`}`);
      if (blockedCount > 0) parts.push(`${blockedCount} of ${used.length} tools blocked for you`);
    }
  }
  return {
    serverId,
    serverName: server.name,
    status: server.status,
    statusLabel,
    breakingPending: Boolean(server.pendingBreakingSnapshotId),
    circuit,
    policy,
    blockingRuleId: blocking?.access.ruleId ?? null,
    blockingRuleName: blocking?.access.ruleName ?? null,
    blockedCount,
    toolCount: used.length,
    description: parts.join(" · ")
  };
}
