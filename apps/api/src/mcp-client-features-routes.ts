/**
 * Phase 10.5 — routes for what MCP servers offer beyond tools, and for the
 * questions they ask back:
 *
 *   - resources and prompts a registry server advertises (from the probe's
 *     catalog, or listed live with `refresh=true`), reading one resource and
 *     rendering one prompt for the playground, each checked against the
 *     tool policy (kinds `resource` and `prompt`);
 *   - elicitation requests waiting for a person, and the answer endpoint.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { secretValuesForScrub, type MCPExecutionContext, type MCPRegistry } from "@ai-orchestrator/mcp-sdk";
import {
  mcpElicitationAnswerSchema,
  mcpPromptGetSchema,
  mcpResourceReadSchema,
  type MCPServerConfig,
  type McpElicitationStatus,
  type McpPolicyKind,
  type McpPolicyRole,
  type McpServerCatalog
} from "@ai-orchestrator/shared";
import type { McpServerRecord } from "./db/database.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { McpElicitationAnswerError, toElicitationView, type McpElicitationService } from "./services/mcp-elicitation-service.js";
import { elicitationVisibleTo, type RunAccess } from "./run-access.js";
import { captureCatalog } from "./services/mcp-probe-service.js";
import { evaluateToolForContext } from "./services/mcp-tool-policy.js";
import type { Store } from "./db/store.js";
import { filterAsync } from "./async-array.js";

export interface McpClientFeatureDeps {
  app: FastifyInstance;
  store: Store;
  mcpRegistry: MCPRegistry;
  elicitations: McpElicitationService;
  /** Largest resource the read endpoint returns, in bytes. */
  resourceMaxBytes: number;
  resolveSecret: MCPExecutionContext["resolveSecret"];
  redact: (value: string) => string;
  /** Phase 10.7 — with an actor, a delegated server acts with that user's own account. */
  resolveRegisteredMcpServer: (registryServerId: string, actor?: SafeUser | null) => Promise<MCPServerConfig>;
  withScopedMcpContext: <T>(run: (context: MCPExecutionContext) => Promise<T>) => Promise<T>;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  canExecuteInProject: (user: SafeUser, projectId: string) => Promise<boolean>;
  /** Project scope: an elicitation follows the workflow whose run asked it. */
  runAccess: RunAccess;
  auditUser: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
}

const MAX_ERROR_CHARS = 2000;

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
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

function emptyCatalog(): McpServerCatalog {
  return { capabilities: {}, resources: [], resourceTemplates: [], prompts: [], updatedAt: "" };
}

export function registerMcpClientFeatureRoutes(deps: McpClientFeatureDeps): void {
  const { app, store } = deps;

  /** Policy context for one user in one project against one registry server. */
  const policyContext = async (server: McpServerRecord, user: SafeUser, projectId: string) => ({
    rules: await store.listMcpToolPolicies(),
    classifications: await store.listMcpToolClassifications(server.id),
    role: user.role as McpPolicyRole,
    projectId,
    adapterId: server.adapterId,
    registryServerId: server.id,
    serverLabel: server.name
  });

  /** Shared preamble of the server-scoped routes: the server, its project and the caller's right to use it. */
  const loadServerForUser = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    user: SafeUser,
    requestedProjectId: string | null | undefined,
    needsExecute: boolean
  ): Promise<{ server: McpServerRecord; projectId: string } | null> => {
    const server = await store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      reply.send({ error: "MCP server not found" });
      return null;
    }
    if (server.projectId && requestedProjectId && requestedProjectId !== server.projectId) {
      reply.code(400);
      reply.send({ error: `MCP server '${server.name}' belongs to another project.` });
      return null;
    }
    const projectId = server.projectId ?? requestedProjectId ?? "default";
    if (!await store.getProject(projectId)) {
      reply.code(400);
      reply.send({ error: `Project '${projectId}' does not exist` });
      return null;
    }
    if (needsExecute && !await deps.canExecuteInProject(user, projectId)) {
      reply.code(403);
      reply.send({ error: `You do not have permission to use MCP servers in project '${projectId}'.` });
      return null;
    }
    return { server, projectId };
  };

  const catalogFor = async (server: McpServerRecord, refresh: boolean, user: SafeUser): Promise<McpServerCatalog> => {
    if (refresh) {
      const serverConfig = await deps.resolveRegisteredMcpServer(server.id, user);
      const adapter = deps.mcpRegistry.get(serverConfig.serverId);
      const live = await deps.withScopedMcpContext((context) => captureCatalog(adapter, serverConfig, context));
      return await store.upsertMcpServerCatalog(server.id, live);
    }
    return await store.getMcpServerCatalog(server.id) ?? emptyCatalog();
  };

  const markAccess = async <T extends { name?: string }>(
    entries: readonly T[],
    nameOf: (entry: T) => string,
    server: McpServerRecord,
    user: SafeUser,
    projectId: string,
    kind: McpPolicyKind
  ) => {
    const context = await policyContext(server, user, projectId);
    return entries.map((entry) => {
      const decision = evaluateToolForContext(context, { name: nameOf(entry) }, kind);
      return {
        ...entry,
        access: decision.allowed
          ? { allowed: true as const }
          : {
              allowed: false as const,
              ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
              ...(decision.ruleName ? { ruleName: decision.ruleName } : {}),
              ...(decision.message ? { message: decision.message } : {})
            }
      };
    });
  };

  const parseQuery = (request: FastifyRequest) => {
    const query = (request.query ?? {}) as { projectId?: unknown; refresh?: unknown };
    return {
      projectId: typeof query.projectId === "string" && query.projectId.trim() ? query.projectId.trim() : null,
      refresh: query.refresh === "true" || query.refresh === "1"
    };
  };

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/resources", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const query = parseQuery(request);
    const loaded = await loadServerForUser(request, reply, user, query.projectId, false);
    if (!loaded) return;
    const { server, projectId } = loaded;
    try {
      const catalog = await catalogFor(server, query.refresh, user);
      return {
        serverId: server.id,
        capabilities: catalog.capabilities,
        updatedAt: catalog.updatedAt || null,
        policy: { role: user.role, projectId },
        resources: await markAccess(catalog.resources, (entry) => entry.uri, server, user, projectId, "resource"),
        resourceTemplates: await markAccess(catalog.resourceTemplates, (entry) => entry.uriTemplate, server, user, projectId, "resource")
      };
    } catch (error) {
      reply.code(502);
      return { error: truncate(deps.redact(error instanceof Error ? error.message : String(error))) };
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/mcp/servers/:id/resources/read", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = mcpResourceReadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid resource read", details: parsed.error.issues };
    }
    const loaded = await loadServerForUser(request, reply, user, parsed.data.projectId ?? null, true);
    if (!loaded) return;
    const { server, projectId } = loaded;
    const uri = parsed.data.uri;
    const decision = evaluateToolForContext(await policyContext(server, user, projectId), { name: uri }, "resource");
    if (!decision.allowed) {
      await deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_resource.read_denied",
        action: "read",
        outcome: "denied",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId,
        metadata: { uri, ruleId: decision.ruleId ?? null, ruleName: decision.ruleName ?? null }
      });
      reply.code(403);
      return {
        error: decision.message ?? `Resource '${uri}' is blocked by policy for role ${user.role}.`,
        policy: { role: user.role, projectId, ruleId: decision.ruleId ?? null, ruleName: decision.ruleName ?? null }
      };
    }
    let serverConfig: MCPServerConfig;
    try {
      serverConfig = await deps.resolveRegisteredMcpServer(server.id, user);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const adapter = deps.mcpRegistry.get(serverConfig.serverId);
    if (typeof adapter.readResource !== "function") {
      reply.code(409);
      return { error: `MCP adapter '${serverConfig.serverId}' cannot read resources.` };
    }
    const started = Date.now();
    let scrubList: string[] = [];
    try {
      const result = await deps.withScopedMcpContext(async (context) => {
        const read = await adapter.readResource!(uri, serverConfig, context, { maxBytes: deps.resourceMaxBytes });
        scrubList = secretValuesForScrub(serverConfig.secretRef ? await deps.resolveSecret(serverConfig.secretRef) : undefined);
        return read;
      });
      const durationMs = Date.now() - started;
      await deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_resource.read",
        action: "read",
        outcome: "success",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId,
        metadata: { uri, bytes: result.bytes, durationMs }
      });
      return {
        serverId: server.id,
        uri: result.uri,
        bytes: result.bytes,
        durationMs,
        contents: scrubValue(result.contents, scrubList),
        policy: { role: user.role, projectId }
      };
    } catch (error) {
      if (scrubList.length === 0 && serverConfig.secretRef) {
        scrubList = secretValuesForScrub(await deps.resolveSecret(serverConfig.secretRef).catch(() => undefined));
      }
      const message = truncate(deps.redact(String(scrubValue(error instanceof Error ? error.message : String(error), scrubList))));
      await deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_resource.read",
        action: "read",
        outcome: "failure",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId,
        metadata: { uri, error: message }
      });
      reply.code(/read limit/.test(message) ? 413 : /not found/i.test(message) ? 404 : 502);
      return { error: message };
    }
  });

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/prompts", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const query = parseQuery(request);
    const loaded = await loadServerForUser(request, reply, user, query.projectId, false);
    if (!loaded) return;
    const { server, projectId } = loaded;
    try {
      const catalog = await catalogFor(server, query.refresh, user);
      return {
        serverId: server.id,
        capabilities: catalog.capabilities,
        updatedAt: catalog.updatedAt || null,
        policy: { role: user.role, projectId },
        prompts: await markAccess(catalog.prompts, (entry) => entry.name, server, user, projectId, "prompt")
      };
    } catch (error) {
      reply.code(502);
      return { error: truncate(deps.redact(error instanceof Error ? error.message : String(error))) };
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/mcp/servers/:id/prompts/get", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = mcpPromptGetSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid prompt request", details: parsed.error.issues };
    }
    const loaded = await loadServerForUser(request, reply, user, parsed.data.projectId ?? null, true);
    if (!loaded) return;
    const { server, projectId } = loaded;
    const name = parsed.data.name;
    const decision = evaluateToolForContext(await policyContext(server, user, projectId), { name }, "prompt");
    if (!decision.allowed) {
      await deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_prompt.get_denied",
        action: "read",
        outcome: "denied",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId,
        metadata: { name, ruleId: decision.ruleId ?? null, ruleName: decision.ruleName ?? null }
      });
      reply.code(403);
      return {
        error: decision.message ?? `Prompt '${name}' is blocked by policy for role ${user.role}.`,
        policy: { role: user.role, projectId, ruleId: decision.ruleId ?? null, ruleName: decision.ruleName ?? null }
      };
    }
    let serverConfig: MCPServerConfig;
    try {
      serverConfig = await deps.resolveRegisteredMcpServer(server.id, user);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const adapter = deps.mcpRegistry.get(serverConfig.serverId);
    if (typeof adapter.getPrompt !== "function") {
      reply.code(409);
      return { error: `MCP adapter '${serverConfig.serverId}' cannot render prompts.` };
    }
    const started = Date.now();
    let scrubList: string[] = [];
    try {
      const prompt = await deps.withScopedMcpContext(async (context) => {
        const rendered = await adapter.getPrompt!(name, parsed.data.arguments, serverConfig, context);
        scrubList = secretValuesForScrub(serverConfig.secretRef ? await deps.resolveSecret(serverConfig.secretRef) : undefined);
        return rendered;
      });
      const durationMs = Date.now() - started;
      await deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_prompt.get",
        action: "read",
        outcome: "success",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId,
        // Argument values are not audited; they may carry user data.
        metadata: { name, arguments: Object.keys(parsed.data.arguments), messageCount: prompt.messages.length, durationMs }
      });
      return { serverId: server.id, durationMs, prompt: scrubValue(prompt, scrubList), policy: { role: user.role, projectId } };
    } catch (error) {
      if (scrubList.length === 0 && serverConfig.secretRef) {
        scrubList = secretValuesForScrub(await deps.resolveSecret(serverConfig.secretRef).catch(() => undefined));
      }
      const message = truncate(deps.redact(String(scrubValue(error instanceof Error ? error.message : String(error), scrubList))));
      reply.code(/not found/i.test(message) ? 404 : /requires the/.test(message) ? 400 : 502);
      return { error: message };
    }
  });

  // ---------------------------------------------------------------------------
  // Elicitations
  // ---------------------------------------------------------------------------

  // Like approvals: only users who can read the run's workflow see the
  // request; answering it needs `workflow:execute` there.
  const visibleTo = (user: SafeUser) => async (record: { createdBy: string | null; workflowId: string }) =>
    await elicitationVisibleTo(deps.runAccess, user, record);

  app.get("/api/mcp/elicitations", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const query = (request.query ?? {}) as { status?: unknown; executionId?: unknown; limit?: unknown };
    const status =
      typeof query.status === "string" && ["pending", "accepted", "declined", "cancelled", "expired", "auto_declined"].includes(query.status)
        ? (query.status as McpElicitationStatus)
        : query.status === "all"
          ? undefined
          : "pending";
    const executionId = typeof query.executionId === "string" && query.executionId.trim() ? query.executionId.trim() : undefined;
    const limit = Number(query.limit);
    const listed = await deps.elicitations.list({ ...(status ? { status } : {}), ...(executionId ? { executionId } : {}), limit: Number.isFinite(limit) ? limit : 100 });
    const items = (await filterAsync(listed, visibleTo(user))).map(toElicitationView);
    return { items };
  });

  app.get<{ Params: { id: string } }>("/api/mcp/elicitations/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const record = await deps.elicitations.get(request.params.id);
    if (!record || !await visibleTo(user)(record)) {
      reply.code(404);
      return { error: "Elicitation request not found" };
    }
    return { elicitation: toElicitationView(record) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/mcp/elicitations/:id/answer", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const parsed = mcpElicitationAnswerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid elicitation answer", details: parsed.error.issues };
    }
    const record = await deps.elicitations.get(request.params.id);
    if (!record || !await visibleTo(user)(record)) {
      reply.code(404);
      return { error: "Elicitation request not found" };
    }
    const access = await deps.runAccess.workflow(user, record.workflowId, "workflow:execute");
    if (!access.ok) {
      reply.code(access.status);
      return { error: access.error };
    }
    try {
      const settled = await deps.elicitations.answer(
        request.params.id,
        { action: parsed.data.action, ...(parsed.data.content ? { content: parsed.data.content } : {}) },
        { userId: user.id, email: user.email, role: user.role }
      );
      // Phase 13.1 — cluster mode: the answer went to the instance running the request, which has not settled it yet.
      if (settled.status === "pending") {
        reply.code(202);
        return { elicitation: toElicitationView(settled), delivered: "signalled" };
      }
      return { elicitation: toElicitationView(settled) };
    } catch (error) {
      if (error instanceof McpElicitationAnswerError) {
        reply.code(error.statusCode);
        return { error: error.message, ...(error.details ? { details: error.details } : {}) };
      }
      throw error;
    }
  });
}
