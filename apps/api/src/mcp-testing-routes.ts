/**
 * Phase 10.8 — MCP testing and reliability routes:
 *
 *   - cassettes: list, read, export and delete what recorded runs captured
 *     (builders read, admins delete). Cassettes are scrubbed before they are
 *     stored, so reading one never reveals a secret.
 *   - `GET /api/mcp/servers/:id/snapshot/export`: a server's accepted schema
 *     snapshot as a file for `l2m mcp check --snapshot` and `l2m mcp mock`.
 *   - `POST /api/mcp/check`: the CI check behind `l2m mcp check`. Probes the
 *     selected servers without recording anything, diffs each against its
 *     accepted snapshot and lists policy-blocked tools workflows depend on.
 *     Works with API keys like every route; builders and admins only.
 *
 * Replaying an execution and recording or replaying eval runs live next to
 * the execution and eval routes in app.ts, since they run workflows.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  judgeMcpCheck,
  mcpCheckRequestSchema,
  type McpCheckBlockedTool,
  type McpCheckReport,
  type McpCheckServerResult,
  type McpToolClassificationOverride,
  type McpToolPolicyRule,
  type McpToolPolicySubject,
  type SecretReference,
  type Workflow
} from "@ai-orchestrator/shared";
import {
  diffToolSnapshots,
  hashToolSnapshot,
  normalizeToolSnapshot,
  type MCPExecutionContext,
  type MCPRegistry
} from "@ai-orchestrator/mcp-sdk";
import type { McpServerRecord } from "./db/database.js";
import { collectRegistryUsages } from "./mcp-control-plane-routes.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { acceptedSnapshotFor, buildSnapshotFile, cassetteSummaryView } from "./services/mcp-cassette-service.js";
import { serverConfigFromRecord } from "./services/mcp-probe-service.js";
import { evaluateToolForContext } from "./services/mcp-tool-policy.js";
import type { Store } from "./db/store.js";

export interface McpTestingDeps {
  app: FastifyInstance;
  store: Store;
  mcpRegistry: MCPRegistry;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  probeTimeoutMs: number;
  loadMcpToolPolicy: () => Promise<{ rules: McpToolPolicyRule[]; classifications: McpToolClassificationOverride[] }>;
  resolveToolPolicySubject: (workflowId: string) => Promise<McpToolPolicySubject>;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** Project scope: cassettes follow the workflow they were recorded for. */
  runAccess: RunAccess;
  audit: (event: AuditEventInput) => void | Promise<void>;
  redact: (value: string) => string;
}

const MAX_ERROR_CHARS = 300;

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Probe timed out after ${timeoutMs} ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe one server without recording anything and compare it with its accepted snapshot. */
async function checkServer(
  deps: McpTestingDeps,
  server: McpServerRecord
): Promise<{ result: McpCheckServerResult; tools: Array<{ name: string; annotations?: Record<string, unknown> }> }> {
  const accepted = await acceptedSnapshotFor(deps.store, server);
  const base: McpCheckServerResult = {
    serverId: server.id,
    name: server.name,
    adapterId: server.adapterId,
    reachable: false,
    error: null,
    latencyMs: null,
    acceptedHash: accepted?.hash ?? null,
    currentHash: null,
    breaking: false,
    changes: []
  };
  const adapter = deps.mcpRegistry.tryGet(server.adapterId);
  if (!adapter) {
    return { result: { ...base, error: `Unknown MCP adapter: ${server.adapterId}` }, tools: [] };
  }
  const context: MCPExecutionContext = { resolveSecret: deps.resolveSecret, runtimeState: new Map<string, unknown>() };
  const started = performance.now();
  const discovery = adapter.discoverTools(serverConfigFromRecord(server), context);
  try {
    const tools = await withTimeout(discovery, deps.probeTimeoutMs);
    const entries = normalizeToolSnapshot(tools);
    const diff = accepted ? diffToolSnapshots(accepted.tools, entries) : { changes: [], breaking: false };
    return {
      result: {
        ...base,
        reachable: true,
        latencyMs: Math.round(performance.now() - started),
        currentHash: hashToolSnapshot(entries),
        breaking: diff.breaking,
        changes: diff.changes
      },
      tools: entries.map((entry) => ({ name: entry.name, ...(entry.annotations ? { annotations: { ...entry.annotations } } : {}) }))
    };
  } catch (error) {
    // A timed-out discovery can still finish opening a session; close that too.
    void discovery.then(
      () => adapter.closeSessions?.(context),
      () => adapter.closeSessions?.(context)
    );
    return {
      result: { ...base, error: truncate(deps.redact(error instanceof Error ? error.message : String(error))), latencyMs: Math.round(performance.now() - started) },
      tools: []
    };
  } finally {
    try {
      await adapter.closeSessions?.(context);
    } catch {
      // Closing a probe session is best effort.
    }
  }
}

export function registerMcpTestingRoutes(deps: McpTestingDeps): void {
  const { app, store } = deps;

  // --- Cassettes ---------------------------------------------------------------

  app.get<{ Querystring: Record<string, unknown> }>("/api/mcp/cassettes", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const query = request.query ?? {};
    const limit = Number(query.limit);
    const offset = Number(query.offset);
    return await store.listMcpCassettes({
      workflowId: str(query.workflowId),
      projectId: str(query.projectId),
      evalRunId: str(query.evalRunId),
      workflowIds: await deps.runAccess.readableWorkflowIds(user) ?? undefined,
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {})
    });
  });

  app.get<{ Params: { id: string } }>("/api/mcp/cassettes/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const cassette = await store.getMcpCassette(request.params.id);
    const access = await deps.runAccess.run(user, cassette && { id: cassette.id, workflowId: cassette.workflowId ?? "" }, "workflow:read", "Cassette");
    if (!access.ok) {
      reply.code(access.status);
      return { error: access.error };
    }
    // Phase 15.3 — the model tape (prompts and answers) and memory seed (earlier sessions' chat history) are
    // scrubbed for secrets, not for personal data: only users who may edit the workflow see them in full.
    const full = cassette && (await deps.runAccess.run(user, { id: cassette.id, workflowId: cassette.workflowId ?? "" }, "workflow:write", "Cassette")).ok;
    return { cassette: cassette && !full ? cassetteSummaryView(cassette) : cassette };
  });

  app.get<{ Params: { id: string } }>("/api/mcp/cassettes/:id/export", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const record = await store.getMcpCassette(request.params.id);
    // Phase 15.3 — the export is the whole cassette (model tape and memory seed included): it needs workflow:write.
    const access = await deps.runAccess.run(user, record && { id: record.id, workflowId: record.workflowId ?? "" }, "workflow:write", "Cassette");
    if (!access.ok || !record) {
      reply.code(access.ok ? 404 : access.status);
      return { error: access.ok ? "Cassette not found" : access.error };
    }
    reply.header("content-disposition", `attachment; filename="${record.id}.json"`);
    return record.cassette;
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/cassettes/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = await store.getMcpCassetteSummary(request.params.id);
    if (!existing || !await store.deleteMcpCassette(existing.id)) {
      reply.code(404);
      return { error: "Cassette not found" };
    }
    await deps.audit({
      category: "execution",
      eventType: "mcp_cassette.deleted",
      action: "delete",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "mcp_cassette",
      resourceId: existing.id,
      projectId: existing.projectId,
      metadata: { executionId: existing.executionId, workflowId: existing.workflowId, calls: existing.callCount }
    });
    return { ok: true };
  });

  // --- Snapshot export ---------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/snapshot/export", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const server = await store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const file = await buildSnapshotFile(store, server);
    if (!file) {
      reply.code(409);
      return { error: `MCP server '${server.name}' has no accepted schema snapshot yet. Probe it first.` };
    }
    reply.header("content-disposition", `attachment; filename="${server.id}.snapshot.json"`);
    return file;
  });

  // --- CI check ------------------------------------------------------------------

  app.post<{ Body: unknown }>("/api/mcp/check", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = mcpCheckRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid check request", details: parsed.error.issues };
    }
    const body = parsed.data;

    let serverIds = new Set(body.serverIds ?? []);
    let workflowFilter = body.workflowIds ? new Set(body.workflowIds) : null;
    if (body.toolsetId) {
      const toolset = await store.getMcpToolset(body.toolsetId) ?? await store.getMcpToolsetBySlug(body.toolsetId);
      if (!toolset) {
        reply.code(404);
        return { error: `Toolset not found: ${body.toolsetId}` };
      }
      const toolsetWorkflows = new Set<string>();
      for (const member of toolset.members) {
        if (member.kind === "server") serverIds.add(member.serverId);
        else toolsetWorkflows.add(member.workflowId);
      }
      // Workflows a toolset publishes count as dependents, and so do the servers they use.
      if (toolsetWorkflows.size > 0) {
        workflowFilter = new Set([...(workflowFilter ?? []), ...toolsetWorkflows]);
        for (const [serverId, usages] of await collectRegistryUsages(store)) {
          if (usages.some((usage) => toolsetWorkflows.has(usage.workflowId))) serverIds.add(serverId);
        }
      }
    }
    const allServers = await store.listMcpServers();
    const unknown = [...serverIds].filter((id) => !allServers.some((server) => server.id === id));
    if (unknown.length > 0) {
      reply.code(404);
      return { error: `MCP server not found: ${unknown.join(", ")}` };
    }
    if (serverIds.size === 0) serverIds = new Set(allServers.map((server) => server.id));
    const servers = allServers.filter((server) => serverIds.has(server.id));

    const checked = await Promise.all(servers.map((server) => checkServer(deps, server)));

    // Policy: tools workflows name explicitly must not be blocked for the workflow's run subject.
    const policy = await deps.loadMcpToolPolicy();
    const usages = await collectRegistryUsages(store);
    const blockedTools: McpCheckBlockedTool[] = [];
    const workflowCache = new Map<string, Workflow | null>();
    for (const [index, server] of servers.entries()) {
      const annotationsByTool = new Map(checked[index].tools.map((tool) => [tool.name, tool.annotations] as const));
      for (const usage of usages.get(server.id) ?? []) {
        if (!usage.toolNames || (workflowFilter && !workflowFilter.has(usage.workflowId))) continue;
        if (!workflowCache.has(usage.workflowId)) workflowCache.set(usage.workflowId, await store.getWorkflow(usage.workflowId) ?? null);
        const workflow = workflowCache.get(usage.workflowId);
        if (!workflow) continue;
        const subject = await deps.resolveToolPolicySubject(workflow.id);
        for (const toolName of usage.toolNames) {
          const decision = evaluateToolForContext(
            {
              rules: policy.rules,
              classifications: policy.classifications,
              role: subject.role,
              projectId: workflow.projectId ?? null,
              adapterId: server.adapterId,
              registryServerId: server.id,
              serverLabel: server.name,
              noWriteTools: Boolean(workflow.settings?.noWriteTools)
            },
            { name: toolName, ...(annotationsByTool.get(toolName) ? { annotations: annotationsByTool.get(toolName) } : {}) }
          );
          if (!decision.allowed) {
            blockedTools.push({
              workflowId: workflow.id,
              workflowName: workflow.name,
              nodeId: usage.nodeId,
              serverId: server.id,
              toolName,
              reason: decision.reason ?? "policy",
              message: decision.message ?? `MCP tool '${toolName}' is blocked.`
            });
          }
        }
      }
    }

    const results = checked.map((entry) => entry.result);
    const judged = judgeMcpCheck(results, blockedTools, {
      ...(body.failOnUnreachable !== undefined ? { failOnUnreachable: body.failOnUnreachable } : {}),
      ...(body.failOnPolicyBlocked !== undefined ? { failOnPolicyBlocked: body.failOnPolicyBlocked } : {})
    });
    const report: McpCheckReport = {
      ok: judged.ok,
      checkedAt: new Date().toISOString(),
      servers: results,
      blockedTools,
      failures: judged.failures
    };
    return report;
  });
}
