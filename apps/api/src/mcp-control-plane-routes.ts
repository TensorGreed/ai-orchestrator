/**
 * Phase 10.3 — read-only routes behind the MCP control plane pages:
 *
 *   - `GET /api/mcp/tools`: one catalogue of every registered server's current
 *     tools with their annotations, classification, the caller's access under
 *     the tool policy, telemetry for a window and the workflow nodes that use
 *     them. `detail=false` skips telemetry and usages (the editor canvas only
 *     needs status and access).
 *   - `GET /api/mcp/changes`: a chronological feed built from schema
 *     snapshots, probe history (status transitions), the deployment's
 *     resource and prompt catalog and the MCP audit events. Builders see what
 *     changed; who changed it and raw audit metadata stay admin-only.
 *   - `GET /api/mcp/overview`: fleet health in one request.
 *
 * Nothing here writes; every route reads the existing tables.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { McpPolicyRole, McpRuntimeStateView, McpToolAnnotations } from "@ai-orchestrator/shared";
import type { McpServerProbeRecord, McpServerRecord, McpServerStatus } from "./db/database.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { McpOAuthService } from "./services/mcp-oauth-service.js";
import { deriveStatus } from "./services/mcp-probe-service.js";
import { markMcpTools } from "./services/mcp-tool-policy.js";
import { loadMcpOpenWorldContext, type McpOpenWorldContext } from "./services/mcp-open-world.js";
import {
  MCP_TELEMETRY_WINDOWS,
  parseMcpTelemetryWindow,
  rollupMcpToolCalls,
  type McpTelemetryWindow
} from "./services/mcp-tool-telemetry.js";
import type { Store } from "./db/store.js";
import { mapAsync } from "./async-array.js";

export interface McpControlPlaneDeps {
  app: FastifyInstance;
  store: Store;
  oauth: Pick<McpOAuthService, "status">;
  usesOAuth: (server: McpServerRecord) => boolean;
  latency: (serverId: string) => Promise<{ samples: number; p50Ms: number | null; p95Ms: number | null; errorRate: number | null }>;
  /** Phase 10.7 — breaker and limit state on this API instance (the last error only for admins). */
  runtime: (serverId: string, user: SafeUser) => McpRuntimeStateView;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** Project scope: recent calls name their workflow only to users who can read it. */
  runAccess: RunAccess;
}

export type McpChangeKind =
  | "schema"
  | "acceptance"
  | "status"
  | "policy"
  | "classification"
  | "toolset"
  | "client"
  | "oauth"
  | "sampling"
  | "catalog"
  | "breaker"
  | "server";

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

export interface McpChangeLink {
  page: "servers" | "policies" | "toolsets" | "clients" | "tools";
  serverId?: string;
  policyId?: string;
  toolName?: string;
}

export interface McpChangeItem {
  id: string;
  at: string;
  kind: McpChangeKind;
  /** `breaking` sorts and renders first-class; `info` is for informational entries. */
  severity: "breaking" | "warning" | "change" | "info";
  serverId: string | null;
  serverName: string | null;
  title: string;
  detail: string | null;
  link: McpChangeLink | null;
  /** Schema changes of a snapshot (tool, kind, breaking, detail). */
  changes?: Array<{ tool: string; kind: string; breaking: boolean; detail: string }>;
  /** Status transition, for `status` entries. */
  transition?: { from: McpServerStatus; to: McpServerStatus };
  /** Admin-only: who made the change and the raw audit metadata. */
  actor?: string | null;
  metadata?: unknown;
}

export interface McpToolUsage {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** True when the node offers every tool of the server rather than naming this one. */
  allTools: boolean;
}

const MAX_CHANGES = 500;
const DEFAULT_CHANGES = 100;
const PROBES_PER_SERVER = 200;
const SNAPSHOTS_PER_SERVER = 50;
const AUDIT_PAGE_SIZE = 500;
const RECENT_CALLS = 10;
const MAX_ERROR_CHARS = 300;

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

const STATUS_LABEL: Record<McpServerStatus, string> = {
  unknown: "Not probed",
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down"
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Every workflow node that references a registry server, keyed by server id. */
export async function collectRegistryUsages(store: Store): Promise<Map<string, Array<McpToolUsage & { toolNames: string[] | null }>>> {
  const byServer = new Map<string, Array<McpToolUsage & { toolNames: string[] | null }>>();
  const push = (serverId: string, entry: McpToolUsage & { toolNames: string[] | null }) => {
    const list = byServer.get(serverId) ?? [];
    list.push(entry);
    byServer.set(serverId, list);
  };
  for (const summary of await store.listWorkflows()) {
    const workflow = await store.getWorkflow(summary.id);
    if (!workflow) continue;
    for (const node of workflow.nodes) {
      const config = asRecord(node.config);
      const base = { workflowId: workflow.id, workflowName: workflow.name, nodeId: node.id, nodeName: node.name, nodeType: node.type };
      const direct = str(config.registryServerId);
      if (direct) {
        const toolName = str(config.toolName);
        const allowed = Array.isArray(config.allowedTools) ? config.allowedTools.map((tool) => String(tool ?? "").trim()).filter(Boolean) : [];
        const names = toolName && toolName !== "__all__" ? [toolName] : allowed.length > 0 ? allowed : null;
        push(direct, { ...base, allTools: names === null, toolNames: names });
      }
      const inline = Array.isArray(config.mcpServers) ? config.mcpServers : [];
      for (const entry of inline) {
        const record = asRecord(entry);
        const serverId = str(record.registryServerId);
        if (!serverId || serverId === direct) continue;
        const allowed = Array.isArray(record.allowedTools) ? record.allowedTools.map((tool) => String(tool ?? "").trim()).filter(Boolean) : [];
        push(serverId, { ...base, allTools: allowed.length === 0, toolNames: allowed.length > 0 ? allowed : null });
      }
    }
  }
  return byServer;
}

/** Status transitions replayed from the probe history (newest first in, oldest first out). */
export function statusTransitions(
  probes: readonly McpServerProbeRecord[]
): Array<{ at: string; probeId: string; from: McpServerStatus; to: McpServerStatus; error: string | null }> {
  const oldestFirst = [...probes].reverse();
  const transitions: Array<{ at: string; probeId: string; from: McpServerStatus; to: McpServerStatus; error: string | null }> = [];
  let previous: McpServerStatus = "unknown";
  for (let index = 0; index < oldestFirst.length; index += 1) {
    const recentNewestFirst = oldestFirst.slice(0, index + 1).reverse();
    const status = deriveStatus(recentNewestFirst);
    if (status !== previous) {
      transitions.push({ at: oldestFirst[index].startedAt, probeId: oldestFirst[index].id, from: previous, to: status, error: oldestFirst[index].error });
      previous = status;
    }
  }
  return transitions;
}

function clientIsActive(client: { revokedAt: string | null; expiresAt: string | null }, now: number): boolean {
  if (client.revokedAt) return false;
  return !client.expiresAt || Date.parse(client.expiresAt) > now;
}

function auditTitle(eventType: string, metadata: Record<string, unknown>, serverName: string | null): { kind: McpChangeKind; title: string; severity: McpChangeItem["severity"] } | null {
  const name = str(metadata.name);
  const server = serverName ?? str(metadata.serverName) ?? "a server";
  switch (eventType) {
    case "mcp_server.created":
      return { kind: "server", title: `Server registered: ${name ?? server}`, severity: "change" };
    case "mcp_server.imported":
      return { kind: "server", title: `Server imported: ${name ?? server}`, severity: "change" };
    case "mcp_server.deleted":
      return { kind: "server", title: `Server removed: ${name ?? server}`, severity: "warning" };
    case "mcp_server.updated": {
      const fields = Array.isArray(metadata.fields) ? metadata.fields.map(String) : [];
      if (fields.includes("sampling")) {
        const other = fields.filter((field) => field !== "sampling");
        return {
          kind: "sampling",
          title: `Sampling settings changed on ${server}${other.length ? ` (also ${other.join(", ")})` : ""}`,
          severity: "change"
        };
      }
      return { kind: "server", title: `Server settings changed on ${server}${fields.length ? `: ${fields.join(", ")}` : ""}`, severity: "change" };
    }
    case "mcp_server.breaking_change_accepted":
      return { kind: "acceptance", title: `Breaking change accepted on ${server}`, severity: "change" };
    case "mcp_server.oauth_connected":
      return { kind: "oauth", title: `OAuth connected on ${server}`, severity: "change" };
    case "mcp_server.oauth_disconnected":
      return { kind: "oauth", title: `OAuth disconnected on ${server}`, severity: "warning" };
    case "mcp_server.oauth_refresh_failed":
      return { kind: "oauth", title: `OAuth token refresh failed on ${server}`, severity: "warning" };
    // Phase 10.7 — delegated credentials and the circuit breaker.
    case "mcp_server.user_oauth_connected":
      return { kind: "oauth", title: `A user connected their own account on ${server}`, severity: "info" };
    case "mcp_server.user_oauth_disconnected":
      return { kind: "oauth", title: `A user disconnected their own account on ${server}`, severity: "info" };
    case "mcp_server.user_oauth_revoked":
      return { kind: "oauth", title: `A user's connection was revoked on ${server}`, severity: "warning" };
    case "mcp_server.user_oauth_refresh_failed":
      return { kind: "oauth", title: `A user's token refresh failed on ${server}`, severity: "warning" };
    case "mcp_server.breaker_opened":
      return { kind: "breaker", title: `Circuit opened on ${server}: calls are paused`, severity: "breaking" };
    case "mcp_server.breaker_half_open":
      return { kind: "breaker", title: `Circuit half-open on ${server}: trying one call`, severity: "info" };
    case "mcp_server.breaker_closed":
      return { kind: "breaker", title: `Circuit closed on ${server}: calls resumed`, severity: "change" };
    case "mcp_server.breaker_reset":
      return { kind: "breaker", title: `Circuit reset by hand on ${server}`, severity: "change" };
    case "mcp_policy.created":
      return { kind: "policy", title: `Policy rule added: ${name ?? `${str(metadata.effect) ?? "rule"} ${str(metadata.toolPattern) ?? "*"}`}`, severity: "change" };
    case "mcp_policy.updated":
      return { kind: "policy", title: `Policy rule changed: ${name ?? str(metadata.toolPattern) ?? "rule"}`, severity: "change" };
    case "mcp_policy.deleted":
      return { kind: "policy", title: `Policy rule removed: ${name ?? str(metadata.toolPattern) ?? "rule"}`, severity: "change" };
    case "mcp_policy.classification_set":
      return {
        kind: "classification",
        title: `${str(metadata.toolName) ?? "Tool"} on ${server} marked ${metadata.readOnly === true ? "read-only" : "write"}`,
        severity: "change"
      };
    case "mcp_policy.classification_cleared":
      return { kind: "classification", title: `${str(metadata.toolName) ?? "Tool"} on ${server} back to its annotation`, severity: "change" };
    case "mcp_toolset.created":
      return { kind: "toolset", title: `Toolset created: ${name ?? str(metadata.slug) ?? "toolset"}`, severity: "change" };
    case "mcp_toolset.updated":
      return { kind: "toolset", title: `Toolset changed: ${name ?? str(metadata.slug) ?? "toolset"}`, severity: "change" };
    case "mcp_toolset.deleted":
      return { kind: "toolset", title: `Toolset removed: ${name ?? str(metadata.slug) ?? "toolset"}`, severity: "change" };
    case "mcp_toolset.member_added":
      return { kind: "toolset", title: `Tool added to toolset ${name ?? str(metadata.slug) ?? ""}`.trim(), severity: "change" };
    case "mcp_toolset.member_removed":
      return { kind: "toolset", title: `Tool removed from toolset ${name ?? str(metadata.slug) ?? ""}`.trim(), severity: "change" };
    case "mcp_client.created":
      return { kind: "client", title: `Client created: ${name ?? "client"}`, severity: "change" };
    case "mcp_client.revoked":
      return { kind: "client", title: `Client revoked: ${name ?? "client"}`, severity: "warning" };
    default:
      return null;
  }
}

/** Audit resource types the feed reads. Gateway traffic, resource reads and playground calls are usage, not changes. */
const AUDIT_RESOURCE_TYPES = ["mcp_server", "mcp_policy", "mcp_toolset", "mcp_client"] as const;

export function registerMcpControlPlaneRoutes(deps: McpControlPlaneDeps): void {
  const { app, store } = deps;

  const parseWindow = (request: FastifyRequest): McpTelemetryWindow | null => {
    const raw = (request.query as { window?: unknown } | undefined)?.window;
    return raw === undefined ? "7d" : parseMcpTelemetryWindow(raw);
  };

  const buildChanges = async (user: SafeUser, filter: { serverId?: string | null; kinds?: Set<McpChangeKind> | null; limit: number }) => {
    const isAdmin = user.role === "admin";
    const servers = await store.listMcpServers();
    const serverNames = new Map(servers.map((server) => [server.id, server.name]));
    const items: McpChangeItem[] = [];
    const wants = (kind: McpChangeKind) => !filter.kinds || filter.kinds.has(kind);

    for (const server of servers) {
      if (filter.serverId && server.id !== filter.serverId) continue;
      if (wants("schema")) {
        for (const snapshot of await store.listMcpToolSnapshots(server.id, SNAPSHOTS_PER_SERVER)) {
          const breakingCount = snapshot.changes.filter((change) => change.breaking).length;
          const baseline = !snapshot.previousSnapshotId;
          items.push({
            id: `snapshot:${snapshot.id}`,
            at: snapshot.createdAt,
            kind: "schema",
            severity: snapshot.breaking ? "breaking" : baseline ? "info" : "change",
            serverId: server.id,
            serverName: server.name,
            title: baseline
              ? `First tool snapshot of ${server.name}: ${snapshot.toolCount} tools`
              : snapshot.breaking
                ? `Breaking schema change on ${server.name}: ${breakingCount} breaking of ${snapshot.changes.length}`
                : `Schema change on ${server.name}: ${snapshot.changes.length} compatible`,
            detail: snapshot.breaking
              ? snapshot.acknowledgedAt
                ? "Accepted"
                : "Waiting for review"
              : null,
            link: { page: "servers", serverId: server.id },
            changes: snapshot.changes.map((change) => ({
              tool: change.tool,
              kind: change.kind,
              breaking: change.breaking,
              detail: change.detail
            }))
          });
        }
      }
      if (wants("status")) {
        for (const transition of statusTransitions(await store.listMcpServerProbes(server.id, PROBES_PER_SERVER))) {
          items.push({
            id: `status:${transition.probeId}`,
            at: transition.at,
            kind: "status",
            severity: transition.to === "down" ? "warning" : transition.to === "degraded" ? "warning" : "change",
            serverId: server.id,
            serverName: server.name,
            title: `${server.name}: ${STATUS_LABEL[transition.from]} → ${STATUS_LABEL[transition.to]}`,
            detail: transition.to === "down" ? transition.error : null,
            link: { page: "servers", serverId: server.id },
            transition: { from: transition.from, to: transition.to }
          });
        }
      }
      if (wants("catalog")) {
        const catalog = await store.getMcpServerCatalog(server.id);
        const listed = catalog ? catalog.resources.length + catalog.resourceTemplates.length + catalog.prompts.length : 0;
        if (catalog && catalog.updatedAt && listed > 0) {
          items.push({
            id: `catalog:${server.id}`,
            at: catalog.updatedAt,
            kind: "catalog",
            severity: "info",
            serverId: server.id,
            serverName: server.name,
            title: `${server.name} lists ${catalog.resources.length} resources, ${catalog.resourceTemplates.length} templates and ${catalog.prompts.length} prompts`,
            detail: "Resource and prompt lists as of the last probe",
            link: { page: "servers", serverId: server.id }
          });
        }
      }
    }

    for (const resourceType of AUDIT_RESOURCE_TYPES) {
      const audit = await store.listAuditLogs({ resourceType, pageSize: AUDIT_PAGE_SIZE });
      for (const entry of audit.items) {
        const metadata = asRecord(entry.metadata);
        const serverId =
          entry.resourceType === "mcp_server"
            ? entry.resourceId
            : str(metadata.serverId) ?? (entry.resourceType === "mcp_policy" && entry.resourceId?.includes(":") ? entry.resourceId.split(":")[0] : null);
        if (filter.serverId && serverId !== filter.serverId) continue;
        const described = auditTitle(entry.eventType, metadata, serverId ? serverNames.get(serverId) ?? null : null);
        if (!described || !wants(described.kind)) continue;
        const link: McpChangeLink | null =
          entry.resourceType === "mcp_policy"
            ? described.kind === "classification"
              ? { page: "tools", ...(serverId ? { serverId } : {}), ...(str(metadata.toolName) ? { toolName: str(metadata.toolName)! } : {}) }
              : { page: "policies", ...(entry.eventType !== "mcp_policy.deleted" && entry.resourceId ? { policyId: entry.resourceId } : {}) }
            : entry.resourceType === "mcp_toolset"
              ? { page: "toolsets" }
              : entry.resourceType === "mcp_client"
                ? { page: "clients" }
                : serverId && serverNames.has(serverId)
                  ? { page: "servers", serverId }
                  : null;
        items.push({
          id: `audit:${entry.id}`,
          at: entry.createdAt,
          kind: described.kind,
          severity: described.severity,
          serverId: serverId ?? null,
          serverName: serverId ? serverNames.get(serverId) ?? str(metadata.name) : null,
          title: described.title,
          detail: null,
          link,
          ...(isAdmin ? { actor: entry.actorEmail, metadata: entry.metadata } : {})
        });
      }
    }

    items.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? 1 : -1));
    return { total: items.length, items: items.slice(0, filter.limit) };
  };

  app.get("/api/mcp/tools", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const query = (request.query ?? {}) as { projectId?: unknown; serverIds?: unknown; detail?: unknown };
    const window = parseWindow(request);
    if (!window) {
      reply.code(400);
      return { error: `window must be one of ${Object.keys(MCP_TELEMETRY_WINDOWS).join(", ")}` };
    }
    const requestedProject = str(query.projectId);
    const detail = query.detail !== "false" && query.detail !== "0";
    const onlyIds =
      typeof query.serverIds === "string" && query.serverIds.trim()
        ? new Set(query.serverIds.split(",").map((id) => id.trim()).filter(Boolean))
        : null;
    const since = new Date(Date.now() - MCP_TELEMETRY_WINDOWS[window]).toISOString();
    const rules = await store.listMcpToolPolicies();
    const usages = detail ? await collectRegistryUsages(store) : new Map<string, Array<McpToolUsage & { toolNames: string[] | null }>>();
    const servers = (await store
      .listMcpServers(requestedProject ? { projectId: requestedProject } : {}))
      .filter((server) => !onlyIds || onlyIds.has(server.id));

    const tools: unknown[] = [];
    const serverViews: unknown[] = [];
    let openWorldContext: McpOpenWorldContext | undefined;
    for (const server of servers) {
      const projectId = server.projectId ?? requestedProject ?? "default";
      const snapshot = server.currentSnapshotId ? await store.getMcpToolSnapshot(server.currentSnapshotId) : null;
      const marked = markMcpTools(snapshot?.tools ?? [], {
        rules,
        classifications: await store.listMcpToolClassifications(server.id),
        role: user.role as McpPolicyRole,
        projectId,
        adapterId: server.adapterId,
        registryServerId: server.id,
        serverLabel: server.name,
        // Phase 12.2 — open world per tool (overrides and destination rows read once for the catalog).
        openWorld: { ...(openWorldContext ??= await loadMcpOpenWorldContext(store)), connection: server.connection }
      });
      const calls = detail ? await store.listMcpToolCalls({ registryServerId: server.id, since }) : [];
      const telemetry = detail ? new Map(rollupMcpToolCalls(calls).tools.map((entry) => [entry.toolName, entry])) : null;
      const recentByTool = new Map<string, unknown[]>();
      const readable = detail ? await deps.runAccess.readableWorkflowIds(user) : null;
      const readableIds = readable && new Set(readable);
      for (const call of [...calls].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
        const list = recentByTool.get(call.toolName) ?? [];
        if (list.length >= RECENT_CALLS) continue;
        const visibleCall = !readableIds || !call.workflowId || readableIds.has(call.workflowId);
        list.push({
          startedAt: call.startedAt,
          ok: call.ok,
          durationMs: call.durationMs,
          source: call.source,
          // A call from a run the user cannot read keeps its outcome but not its workflow or error text.
          workflowId: visibleCall ? call.workflowId || null : null,
          error: visibleCall && call.error ? truncate(call.error) : null,
          // Phase 12.4 — the call's safe argument summary and subject role, for admins only.
          ...(user.role === "admin" && visibleCall
            ? { argsSummary: call.argsSummary ?? null, subjectRole: call.subjectRole ?? null }
            : {})
        });
        recentByTool.set(call.toolName, list);
      }
      const serverUsages = usages.get(server.id) ?? [];
      serverViews.push({
        id: server.id,
        name: server.name,
        status: server.status,
        adapterId: server.adapterId,
        projectId: server.projectId,
        lastProbeAt: server.lastProbeAt,
        pendingBreakingSnapshotId: server.pendingBreakingSnapshotId,
        toolCount: server.toolCount,
        policyProjectId: projectId,
        // Phase 10.7 — the canvas shows "Circuit open" on nodes of a paused server.
        breakerState: deps.runtime(server.id, user).breaker.state,
        breakerRetryAt: deps.runtime(server.id, user).breaker.retryAt
      });
      for (const tool of marked) {
        const annotations: McpToolAnnotations | undefined = tool.annotations;
        tools.push({
          serverId: server.id,
          serverName: server.name,
          serverStatus: server.status,
          adapterId: server.adapterId,
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(annotations ? { annotations } : {}),
          classification: tool.classification,
          manualReadOnly: tool.manualReadOnly,
          access: tool.access,
          ...(tool.openWorld ? { openWorld: tool.openWorld, manualOpenWorld: tool.manualOpenWorld ?? null } : {}),
          ...(telemetry ? { telemetry: telemetry.get(tool.name) ?? null, recentCalls: recentByTool.get(tool.name) ?? [] } : {}),
          ...(detail
            ? {
                usages: serverUsages
                  .filter((usage) => usage.toolNames === null || usage.toolNames.includes(tool.name))
                  .map(({ toolNames: _toolNames, ...usage }) => usage)
              }
            : {})
        });
      }
    }
    return {
      window,
      since,
      policy: { role: user.role, projectId: requestedProject ?? "default" },
      servers: serverViews,
      tools
    };
  });

  app.get("/api/mcp/changes", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const query = (request.query ?? {}) as { serverId?: unknown; kind?: unknown; limit?: unknown };
    let kinds: Set<McpChangeKind> | null = null;
    if (typeof query.kind === "string" && query.kind.trim()) {
      const requested = query.kind.split(",").map((kind) => kind.trim()).filter(Boolean);
      const unknown = requested.filter((kind) => !MCP_CHANGE_KINDS.includes(kind as McpChangeKind));
      if (unknown.length > 0) {
        reply.code(400);
        return { error: `kind must be one of ${MCP_CHANGE_KINDS.join(", ")}` };
      }
      kinds = new Set(requested as McpChangeKind[]);
    }
    const limitRaw = Number(query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_CHANGES, Math.floor(limitRaw)) : DEFAULT_CHANGES;
    const serverId = str(query.serverId);
    return { kinds: MCP_CHANGE_KINDS, ...await buildChanges(user, { serverId, kinds, limit }) };
  });

  app.get("/api/mcp/overview", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const window = parseWindow(request);
    if (!window) {
      reply.code(400);
      return { error: `window must be one of ${Object.keys(MCP_TELEMETRY_WINDOWS).join(", ")}` };
    }
    const isAdmin = user.role === "admin";
    const now = Date.now();
    const since = new Date(now - MCP_TELEMETRY_WINDOWS[window]).toISOString();
    const servers = await store.listMcpServers();
    const byStatus: Record<McpServerStatus, number> = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
    const tools: Array<{ serverId: string; serverName: string; toolName: string; calls: number; errors: number; errorRate: number; p95Ms: number | null; costUsd: number | null }> = [];
    const pendingBreaking: unknown[] = [];
    const oauthAttention: unknown[] = [];
    const sampling: unknown[] = [];
    const breakers: unknown[] = [];
    const sandboxAttention: unknown[] = [];
    let totalCalls = 0;
    let totalErrors = 0;

    for (const server of servers) {
      byStatus[server.status] += 1;
      if (server.pendingBreakingSnapshotId) {
        const snapshot = await store.getMcpToolSnapshot(server.pendingBreakingSnapshotId);
        pendingBreaking.push({
          serverId: server.id,
          serverName: server.name,
          snapshotId: server.pendingBreakingSnapshotId,
          detectedAt: snapshot?.createdAt ?? null,
          breakingChanges: snapshot ? snapshot.changes.filter((change) => change.breaking).length : 0,
          blocksRuns: server.blockOnBreakingChange
        });
      }
      // Phase 10.7 — open or half-open breakers on this instance, and sandboxes that cannot start.
      const runtime = deps.runtime(server.id, user);
      if (runtime.breaker.state !== "closed") {
        breakers.push({
          serverId: server.id,
          serverName: server.name,
          state: runtime.breaker.state,
          since: runtime.breaker.since,
          retryAt: runtime.breaker.retryAt,
          consecutiveFailures: runtime.breaker.consecutiveFailures,
          ...(isAdmin ? { lastError: runtime.breaker.lastError } : {})
        });
      }
      if (server.adapterId === "stdio_mcp" && server.sandboxStatus && !server.sandboxStatus.ok) {
        sandboxAttention.push({
          serverId: server.id,
          serverName: server.name,
          mode: server.sandboxStatus.mode,
          problems: server.sandboxStatus.problems,
          checkedAt: server.sandboxStatus.checkedAt
        });
      }
      // A delegated server has no shared connection to watch; each user connects their own.
      if (deps.usesOAuth(server) && server.credentialMode !== "delegated") {
        const status = await deps.oauth.status(server.id);
        if (status.state !== "connected") {
          oauthAttention.push({
            serverId: server.id,
            serverName: server.name,
            state: status.state,
            expiresAt: status.expiresAt,
            ...(isAdmin ? { lastError: status.lastError } : {})
          });
        }
      }
      if (server.sampling?.allow) {
        sampling.push({
          serverId: server.id,
          serverName: server.name,
          maxTokens: server.sampling.maxTokens,
          maxRequestsPerCall: server.sampling.maxRequestsPerCall,
          allowedModels: server.sampling.allowedModels.length
        });
      }
      const rollup = rollupMcpToolCalls(await store.listMcpToolCalls({ registryServerId: server.id, since }));
      totalCalls += rollup.totals.calls;
      totalErrors += rollup.totals.errors;
      for (const tool of rollup.tools) {
        tools.push({
          serverId: server.id,
          serverName: server.name,
          toolName: tool.toolName,
          calls: tool.calls,
          errors: tool.errors,
          errorRate: tool.errorRate,
          p95Ms: tool.p95Ms,
          costUsd: tool.costUsd
        });
      }
    }

    const busiest = [...tools].sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName)).slice(0, 5);
    const errorProne = tools
      .filter((tool) => tool.errors > 0)
      .sort((a, b) => b.errorRate - a.errorRate || b.errors - a.errors || a.toolName.localeCompare(b.toolName))
      .slice(0, 5);

    const visibleElicitation = (record: { createdBy: string | null }) =>
      user.role === "admin" || user.role === "operator" || !record.createdBy || record.createdBy === user.id;
    const openQuestions = (await store.listMcpElicitations({ status: "pending", limit: 500 })).filter(visibleElicitation);

    const clientUsage = new Map((await store.summarizeMcpClientUsage(since)).map((row) => [row.clientId, row]));
    const clients = await store.listMcpClients();
    const activeClients = clients
      .filter((client) => clientIsActive(client, now))
      .map((client) => ({
        id: client.id,
        name: client.name,
        calls: clientUsage.get(client.id)?.calls ?? 0,
        errors: clientUsage.get(client.id)?.errors ?? 0,
        lastCalledAt: clientUsage.get(client.id)?.lastCalledAt ?? null
      }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

    return {
      window,
      since,
      servers: {
        total: servers.length,
        byStatus,
        list: await mapAsync(servers, async (server) => ({
          id: server.id,
          name: server.name,
          status: server.status,
          lastProbeAt: server.lastProbeAt,
          latency: await deps.latency(server.id)
        }))
      },
      pendingBreaking,
      oauthAttention,
      breakers,
      sandboxAttention,
      elicitations: {
        pending: openQuestions.length,
        oldestAt: openQuestions.reduce<string | null>((oldest, record) => (!oldest || record.createdAt < oldest ? record.createdAt : oldest), null)
      },
      sampling,
      tools: { calls: totalCalls, errors: totalErrors, busiest, errorProne },
      clients: { total: clients.length, active: activeClients.length, top: activeClients.slice(0, 5) },
      changes: (await buildChanges(user, { kinds: null, limit: 8 })).items
    };
  });
}
