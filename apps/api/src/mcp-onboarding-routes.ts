/**
 * Phase 10.6 — MCP onboarding routes: import client config files into the
 * registry, the deployment-local catalog's status, and the playground that
 * calls one registry tool for the signed-in user.
 */

import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { secretValuesForScrub, type MCPExecutionContext, type MCPRegistry } from "@ai-orchestrator/mcp-sdk";
import {
  mcpConfigImportRequestSchema,
  mcpPlaygroundCallSchema,
  type MCPServerConfig,
  type McpConfigImportResponse,
  type McpImportEntryView,
  type McpPlaygroundCallResponse,
  type McpPlaygroundExchange,
  type McpPolicyRole,
  type SecretReference
} from "@ai-orchestrator/shared";
import type { McpServerRecord, SqliteStore } from "./db/database.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { McpCatalogService } from "./services/mcp-catalog.js";
import {
  McpConfigImportError,
  isSecretName,
  maskCredentialArgs,
  materializeImportEntry,
  parseMcpClientConfig,
  planMcpConfigImport,
  summarizeImportEntries
} from "./services/mcp-config-import.js";
import { toolError, toolSuccess } from "./services/mcp-gateway-protocol.js";
import { evaluateToolForContext } from "./services/mcp-tool-policy.js";

const MASK = "••••••";
const MAX_ERROR_CHARS = 2000;

export interface McpOnboardingDeps {
  app: FastifyInstance;
  store: SqliteStore;
  mcpRegistry: MCPRegistry;
  catalog: McpCatalogService;
  createSecret: (input: { name: string; provider: string; value: string; projectId?: string }) => SecretReference;
  resolveSecret: MCPExecutionContext["resolveSecret"];
  redact: (value: string) => string;
  resolveRegisteredMcpServer: (registryServerId: string) => MCPServerConfig;
  withScopedMcpContext: <T>(run: (context: MCPExecutionContext) => Promise<T>) => Promise<T>;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  auditUser: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
  /** Probe a server in the background, like a normal registration. */
  probeInBackground: (serverId: string) => void;
  serverSummary: (server: McpServerRecord) => unknown;
}

function scrubValue(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, scrubValue(nested, secrets)]));
  }
  return value;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(toRecord(value))) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** The transport a playground call used, with every credential masked. */
export function describeTransport(server: McpServerRecord): McpPlaygroundExchange["transport"] {
  const connection = server.connection ?? {};
  if (server.adapterId === "stdio_mcp") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(stringMap(connection.env))) env[key] = isSecretName(key) ? MASK : value;
    if (typeof connection.secretEnvVar === "string" && server.secretId) env[connection.secretEnvVar] = MASK;
    for (const name of Array.isArray(connection.secretEnvVars) ? connection.secretEnvVars.map(String) : []) env[name] = MASK;
    return {
      kind: "stdio",
      command: String(connection.command ?? ""),
      args: maskCredentialArgs(Array.isArray(connection.args) ? connection.args.map(String) : []),
      env
    };
  }
  if (server.adapterId === "http_mcp") {
    const headers: Record<string, string> = {};
    const authType = String(connection.authType ?? "none").toLowerCase();
    if (authType === "bearer") headers.Authorization = `Bearer ${MASK}`;
    if (authType === "basic") headers.Authorization = `Basic ${MASK}`;
    for (const [key, value] of Object.entries(stringMap(connection.headers))) headers[key] = isSecretName(key) ? MASK : value;
    for (const name of Array.isArray(connection.secretHeaders) ? connection.secretHeaders.map(String) : []) headers[name] = MASK;
    return { kind: "http", endpoint: String(connection.endpoint ?? ""), headers };
  }
  return { kind: "other", adapterId: server.adapterId };
}

export function registerMcpOnboardingRoutes(deps: McpOnboardingDeps): void {
  const { app, store, catalog } = deps;

  // ---------------------------------------------------------------------------
  // Config import
  // ---------------------------------------------------------------------------

  app.post<{ Body: unknown }>("/api/mcp/servers/import", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = mcpConfigImportRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid MCP config import payload", details: parsed.error.issues };
    }
    const dryRun = parsed.data.dryRun === true;
    if (!dryRun && user.role !== "admin") {
      reply.code(403);
      return { error: "Only admins can import MCP servers; builders may preview with dryRun." };
    }
    const projectId = parsed.data.projectId ?? null;
    if (projectId && !store.getProject(projectId)) {
      reply.code(400);
      return { error: `Project '${projectId}' does not exist` };
    }

    let config: ReturnType<typeof parseMcpClientConfig>;
    try {
      config = parseMcpClientConfig(parsed.data.content);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof McpConfigImportError ? error.message : "The file could not be read as an MCP client config." };
    }

    const existing = store.listMcpServers();
    const plan = planMcpConfigImport(config, {
      existing,
      entries: parsed.data.entries,
      checkStdioCommand: (command, args) => catalog.checkStdioCommand(command, args)
    });

    const respond = (entries: McpImportEntryView[]): McpConfigImportResponse => ({
      dryRun,
      format: plan.format,
      sourceName: parsed.data.fileName ?? null,
      entries,
      summary: summarizeImportEntries(entries),
      warnings: plan.warnings
    });

    if (dryRun) return respond(plan.entries.map((entry) => entry.view));

    const results: McpImportEntryView[] = [];
    const created: string[] = [];
    const updated: string[] = [];
    const probe = parsed.data.probe !== false;
    for (const entry of plan.entries) {
      const view = entry.view;
      if (view.decision === "skip") {
        results.push({ ...view, result: { action: "skipped", reason: view.blockedReason ?? "Skipped by choice." } });
        continue;
      }
      if (view.blockedReason) {
        results.push({ ...view, result: { action: "skipped", reason: view.blockedReason } });
        continue;
      }
      const values = parsed.data.entries?.[view.key]?.values ?? {};
      const materialized = materializeImportEntry(entry, values);
      if (materialized.missing.length > 0) {
        results.push({ ...view, result: { action: "skipped", reason: `Values needed: ${materialized.missing.join(", ")}.` } });
        continue;
      }
      let secretId: string | null = null;
      if (materialized.secret) {
        const ref = deps.createSecret({
          name: `MCP ${view.name}: ${materialized.secret.names.join(", ")}`.slice(0, 200),
          provider: "mcp",
          value: materialized.secret.value,
          ...(projectId ? { projectId } : {})
        });
        secretId = ref.secretId;
        deps.auditUser(request, user, {
          category: "secret",
          eventType: "secret.create",
          action: "create",
          resourceType: "secret",
          resourceId: secretId,
          projectId: projectId ?? "default",
          metadata: { name: `MCP ${view.name}`, provider: "mcp", source: "local", importedFor: view.name, names: materialized.secret.names }
        });
      }
      const probeEnabled = !view.disabledInSource;
      if (view.decision === "update" && view.duplicate) {
        store.updateMcpServer(view.duplicate.serverId, {
          adapterId: view.adapterId,
          connection: materialized.connection,
          secretId
        });
        updated.push(view.duplicate.serverId);
        if (probe && store.getMcpServer(view.duplicate.serverId)?.probeEnabled) deps.probeInBackground(view.duplicate.serverId);
        results.push({ ...view, result: { action: "updated", serverId: view.duplicate.serverId, ...(secretId ? { secretId } : {}) } });
        continue;
      }
      const id = `mcp_${crypto.randomUUID()}`;
      store.createMcpServer({
        id,
        name: view.name,
        description: `Imported from ${parsed.data.fileName ?? "a client config"} (${view.key})`.slice(0, 2000),
        adapterId: view.adapterId,
        connection: materialized.connection,
        secretId,
        owner: user.email,
        projectId,
        probeEnabled,
        createdBy: user.email
      });
      created.push(id);
      if (probe && probeEnabled) deps.probeInBackground(id);
      results.push({ ...view, result: { action: "created", serverId: id, ...(secretId ? { secretId } : {}) } });
    }

    deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_server.imported",
      action: "create",
      outcome: "success",
      resourceType: "mcp_server",
      resourceId: created[0] ?? updated[0] ?? "none",
      projectId,
      metadata: {
        format: plan.format,
        fileName: parsed.data.fileName ?? null,
        created,
        updated,
        entries: results.map((entry) => ({
          key: entry.key,
          name: entry.name,
          adapterId: entry.adapterId,
          decision: entry.decision,
          action: entry.result?.action,
          serverId: entry.result?.serverId ?? null,
          // Names only; values never reach the audit log.
          secretNames: entry.slots.filter((slot) => slot.kind === "secret").map((slot) => slot.name)
        }))
      }
    });

    return {
      ...respond(results),
      servers: [...created, ...updated]
        .map((serverId) => store.getMcpServer(serverId))
        .filter((server): server is McpServerRecord => Boolean(server))
        .map(deps.serverSummary)
    };
  });

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  app.get("/api/mcp/catalog", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    return { status: catalog.status(), entries: catalog.listEntries() };
  });

  app.post("/api/mcp/catalog/reload", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (!catalog.configured) {
      reply.code(409);
      return { error: "No catalog file is configured (MCP_CATALOG_FILE).", status: catalog.status() };
    }
    const status = catalog.reload();
    deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_catalog.reloaded",
      action: "update",
      outcome: status.state === "error" ? "failure" : "success",
      resourceType: "mcp_catalog",
      resourceId: status.fileName ?? "catalog",
      metadata: { state: status.state, entries: status.entryCount, errors: status.errors.length }
    });
    return { status, entries: catalog.listEntries() };
  });

  // ---------------------------------------------------------------------------
  // Playground
  // ---------------------------------------------------------------------------

  let rpcSequence = 0;

  app.post<{ Params: { id: string }; Body: unknown }>("/api/mcp/servers/:id/playground/call", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = mcpPlaygroundCallSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid playground call", details: parsed.error.issues };
    }
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const projectId = parsed.data.projectId ?? server.projectId ?? "default";
    if (!store.getProject(projectId)) {
      reply.code(400);
      return { error: `Project '${projectId}' does not exist` };
    }
    const snapshot = server.currentSnapshotId ? store.getMcpToolSnapshot(server.currentSnapshotId) : null;
    if (!snapshot) {
      reply.code(409);
      return { error: `MCP server '${server.name}' has no tool snapshot yet. Probe it first.` };
    }
    const toolName = parsed.data.toolName;
    const tool = snapshot.tools.find((entry) => entry.name === toolName);
    if (!tool) {
      reply.code(404);
      return { error: `Tool '${toolName}' is not in the server's current snapshot. Probe the server to refresh it.` };
    }

    const decision = evaluateToolForContext(
      {
        rules: store.listMcpToolPolicies(),
        classifications: store.listMcpToolClassifications(server.id),
        role: user.role as McpPolicyRole,
        projectId,
        adapterId: server.adapterId,
        registryServerId: server.id,
        serverLabel: server.name
      },
      { name: tool.name, ...(tool.annotations ? { annotations: tool.annotations } : {}) }
    );
    if (!decision.allowed) {
      deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_tool.playground_denied",
        action: "execute",
        outcome: "denied",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId,
        metadata: { toolName, ruleId: decision.ruleId ?? null, ruleName: decision.ruleName ?? null }
      });
      reply.code(403);
      return {
        error: decision.message ?? `Tool '${toolName}' is blocked by policy for role ${user.role}.`,
        policy: { role: user.role, projectId, ruleId: decision.ruleId ?? null, ruleName: decision.ruleName ?? null }
      };
    }
    if (!decision.classification.readOnly && parsed.data.confirmWrite !== true) {
      reply.code(409);
      return {
        error: `'${toolName}' may change data on '${server.name}'. Confirm to call it.`,
        requiresConfirmation: true,
        classification: decision.classification
      };
    }

    let serverConfig: MCPServerConfig;
    try {
      serverConfig = deps.resolveRegisteredMcpServer(server.id);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }

    rpcSequence += 1;
    const rpcId = rpcSequence;
    const rpcRequest = { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name: toolName, arguments: parsed.data.args } };
    const startedAt = new Date();
    let ok = false;
    let output: unknown = null;
    let errorText: string | null = null;
    let scrubList: string[] = [];
    try {
      const outcome = await deps.withScopedMcpContext(async (context) => {
        const result = await deps.mcpRegistry.get(serverConfig.serverId).invokeTool(toolName, parsed.data.args, serverConfig, context);
        scrubList = secretValuesForScrub(serverConfig.secretRef ? await deps.resolveSecret(serverConfig.secretRef) : undefined);
        return result;
      });
      if (outcome.ok) {
        ok = true;
        output = scrubValue(outcome.output ?? null, scrubList);
      } else {
        errorText = truncate(deps.redact(String(scrubValue(outcome.error ?? `MCP tool '${toolName}' failed.`, scrubList))));
      }
    } catch (error) {
      if (scrubList.length === 0 && serverConfig.secretRef) {
        scrubList = secretValuesForScrub(await deps.resolveSecret(serverConfig.secretRef).catch(() => undefined));
      }
      errorText = truncate(deps.redact(String(scrubValue(error instanceof Error ? error.message : String(error), scrubList))));
    }
    const durationMs = Date.now() - startedAt.getTime();
    const telemetryId = `mtc_${crypto.randomUUID()}`;
    try {
      store.insertMcpToolCall({
        id: telemetryId,
        executionId: `mcppg_${crypto.randomUUID()}`,
        workflowId: "",
        nodeId: "",
        registryServerId: server.id,
        adapterId: server.adapterId,
        toolName,
        startedAt: startedAt.toISOString(),
        durationMs,
        ok,
        error: errorText,
        turnInputTokens: null,
        turnOutputTokens: null,
        estimatedCostUsd: null,
        source: "playground",
        clientId: null
      });
    } catch (error) {
      app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "Failed to record MCP playground telemetry");
    }
    deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_tool.playground_call",
      action: "execute",
      outcome: ok ? "success" : "failure",
      resourceType: "mcp_server",
      resourceId: server.id,
      projectId,
      // Arguments and results are not audited; they may carry user data.
      metadata: { toolName, readOnly: decision.classification.readOnly, durationMs, ok }
    });

    const result = ok ? toolSuccess(output) : toolError(errorText ?? "The tool call failed.");
    const response: McpPlaygroundCallResponse = {
      ok,
      durationMs,
      toolName,
      serverId: server.id,
      classification: decision.classification,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      result,
      exchange: {
        transport: describeTransport(server),
        request: rpcRequest,
        response: { jsonrpc: "2.0", id: rpcId, result },
        note: "The request is the tools/call message L2M sends to the server. The response shows the result the adapter returned, in tools/call form; credentials are masked and injected secret values are redacted."
      },
      policy: { role: user.role, projectId },
      telemetryId
    };
    return response;
  });
}
