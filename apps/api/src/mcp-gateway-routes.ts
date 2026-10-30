/**
 * Phase 10.4 — L2M as an MCP server and gateway.
 *
 * `/mcp/<toolset>` speaks the MCP Streamable HTTP transport (JSON-RPC 2.0
 * over POST; JSON responses, or an SSE stream when a request asks for
 * progress). Each toolset bundles workflow tools (`mcp_server_trigger`) and
 * tools re-exposed from registry servers. Registry calls take the same path
 * an agent's call takes: registry resolution (and its breaking-change gate),
 * secret injection, tool policy for the client's role, telemetry and audit.
 *
 * The admin API under /api/mcp/toolsets and /api/mcp/clients manages
 * toolsets and client credentials.
 */

import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  policyDecisionRecord,
  secretValuesForScrub,
  type MCPExecutionContext,
  type McpToolAccessDecision,
  type MCPRegistry
} from "@ai-orchestrator/mcp-sdk";
import {
  canonicalPolicyJson,
  mcpClientCreateSchema,
  mcpPolicyRoleSchema,
  mcpToolsetInputSchema,
  mcpToolsetMemberInputSchema,
  mcpToolsetUpdateSchema,
  type MCPServerConfig,
  type McpClient,
  type McpGatewayApproval,
  type McpPolicyRole,
  type McpToolPolicyDecisionRecord,
  type McpToolPolicyRule,
  type McpToolPolicySubject,
  type McpToolset,
  type McpToolsetMemberSpec,
  type McpSamplingTraceEntry,
  type Workflow
} from "@ai-orchestrator/shared";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { createMcpSamplingHandler } from "@ai-orchestrator/workflow-engine";
import type { z } from "zod";
import { DEFAULT_MCP_GATEWAY_APPROVAL_WINDOW_MS, type AppConfig } from "./config.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { evaluateToolForContext } from "./services/mcp-tool-policy.js";
import { withDelegatedUser } from "@ai-orchestrator/mcp-sdk";
import type { MCPToolResult, McpRuntimeRejection } from "@ai-orchestrator/shared";
import {
  buildGatewayCatalog,
  toMcpToolDescriptor,
  toToolView,
  type GatewayCatalog,
  type GatewayServerTool,
  type GatewayWorkflowTool
} from "./services/mcp-gateway-catalog.js";
import {
  JSON_RPC_ERRORS,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  TOOLS_PAGE_SIZE,
  acceptAllows,
  classifyMessage,
  decodeCursor,
  encodeCursor,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  requestKey,
  rpcError,
  rpcResult,
  toolError,
  toolSuccess,
  versionAllowsBatches,
  type ClassifiedMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallToolResult
} from "./services/mcp-gateway-protocol.js";

/** Phase 10.7 — a server tool call the runtime guard refused before it reached the server. */
interface GatewayRetryLater {
  retryLater: true;
  reason: McpRuntimeRejection;
  retryAfterMs: number;
  message: string;
}

function isRetryLater(value: unknown): value is GatewayRetryLater {
  return Boolean(value && typeof value === "object" && (value as { retryLater?: unknown }).retryLater === true);
}

/** The runtime guard refused the call before it reached the server. */
function isRuntimeRefusal(kind: string | undefined): kind is McpRuntimeRejection {
  return kind === "rate_limited" || kind === "concurrency_limited" || kind === "circuit_open";
}
import {
  GatewaySessionLimitError,
  GatewaySessionManager,
  type GatewaySession
} from "./services/mcp-gateway-sessions.js";
import { McpClientService, capRole, resolveMcpClientSubject, roleRank } from "./services/mcp-client-service.js";
import { MCP_TELEMETRY_WINDOWS, parseMcpTelemetryWindow, rollupMcpToolCalls } from "./services/mcp-tool-telemetry.js";
import { startSseHeartbeat } from "./sse-heartbeat.js";
import type { Store } from "./db/store.js";
import { filterAsync, mapAsync } from "./async-array.js";

const SERVER_VERSION = "0.1.0";
const MAX_ERROR_CHARS = 500;
/** Phase 12.4 — how long a gateway approval request waits for a decision before it expires. */
export const GATEWAY_APPROVAL_PENDING_MS = 24 * 60 * 60 * 1000;
const GATEWAY_APPROVAL_PREVIEW_CHARS = 2000;
/**
 * Phase 12.4 — at most this many pending approval requests per gateway client. A client over the cap gets a
 * "retry later" error instead of a new request, so an outside app cannot flood the admins' inbox.
 */
export const GATEWAY_APPROVAL_MAX_PENDING_PER_CLIENT = 20;
/** Phase 12.4 — the retry hint sent with that error. */
const GATEWAY_APPROVAL_CAP_RETRY_MS = 60_000;
const GATEWAY_APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "used"] as const;

/**
 * The tool policy for one sampling request a server makes during a gateway call. Phase 12.4: the calling client is
 * the principal, so a sampling rule scoped to that client governs it like the client's own calls.
 */
export function evaluateGatewaySampling(
  rules: readonly McpToolPolicyRule[],
  input: {
    role: McpPolicyRole;
    projectId: string | null;
    adapterId: string;
    registryServerId: string;
    serverLabel?: string;
    clientId: string;
    model: string;
  }
): McpToolAccessDecision {
  return evaluateToolForContext(
    {
      rules,
      classifications: [],
      role: input.role,
      projectId: input.projectId,
      adapterId: input.adapterId,
      registryServerId: input.registryServerId,
      ...(input.serverLabel ? { serverLabel: input.serverLabel } : {}),
      clientId: input.clientId
    },
    { name: input.model },
    "sampling"
  );
}

/** Phase 12.4 — the identical-call hash of gateway arguments: key order and nesting do not change it. */
export function gatewayArgsHash(args: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(canonicalPolicyJson(args)).digest("hex");
}
/** Adapter id recorded on telemetry rows of workflow tools called through the gateway. */
export const GATEWAY_WORKFLOW_ADAPTER_ID = "workflow";

export interface GatewayWorkflowRunOutcome {
  status: string;
  output?: unknown;
  error?: string;
}

export interface McpGatewayDeps {
  app: FastifyInstance;
  config: AppConfig;
  store: Store;
  mcpRegistry: MCPRegistry;
  /** Phase 10.5 — answers `sampling/createMessage` with a server's default model; absent means sampling is refused. */
  providerRegistry?: ProviderRegistry;
  resolveSecret: MCPExecutionContext["resolveSecret"];
  redact: (value: string) => string;
  resolveRegisteredMcpServer: (registryServerId: string) => Promise<MCPServerConfig>;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** Project scope: toolset candidates only list workflows the user can read. */
  runAccess: RunAccess;
  /** Audit with the signed-in admin as actor. */
  auditUser: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
  /** Audit with an MCP client as actor. */
  auditRaw: (event: AuditEventInput) => void | Promise<void>;
  /**
   * Run a workflow tool like the REST invoke route does, with the client's
   * policy subject, record it in execution history and return its outcome.
   */
  runWorkflowTool: (input: {
    workflow: Workflow;
    nodeId: string;
    toolName: string;
    args: Record<string, unknown>;
    executionId: string;
    subject: McpToolPolicySubject;
    client: McpClient;
    onNodeComplete: (event: { nodeId: string; status: string }) => void;
  }) => Promise<GatewayWorkflowRunOutcome>;
  /** Abort a running workflow execution. */
  cancelExecution: (executionId: string, reason: string) => void;
  /**
   * Phase 15.4 — the workflow gateway clients see and call: the published
   * version when there is one (gateway calls are production traffic), else
   * the draft. The admin API (toolset members, candidates) reads drafts.
   */
  loadProductionWorkflow?: (id: string) => Promise<Workflow | null>;
  /** Phase 15.4 — why production refuses an existing workflow (a deactivated gated one); the tool call reports it. */
  productionRefusal?: (id: string) => Promise<string | null>;
}

interface AuthenticatedClient {
  client: McpClient;
  subject: McpToolPolicySubject;
}

type Emit = (notification: JsonRpcNotification) => void;

/** Sentinel for a request whose response must not be sent (cancelled while streaming). */
const SUPPRESSED = Symbol("suppressed");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function parseOriginList(...values: string[]): Set<string> {
  const origins = new Set<string>();
  for (const value of values) {
    for (const entry of value.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      try {
        origins.add(new URL(trimmed).origin.toLowerCase());
      } catch {
        // Config validation rejects malformed MCP origins; WEB_ORIGIN entries are best effort.
      }
    }
  }
  return origins;
}

/**
 * Origins a browser may call the endpoint from: MCP_GATEWAY_ALLOWED_ORIGINS,
 * plus the studio's own origins (WEB_ORIGIN) and MCP_GATEWAY_PUBLIC_URL. The
 * Host header is never trusted for this: under DNS rebinding it carries the
 * attacker's name.
 */
export function gatewayAllowedOrigins(config: Pick<AppConfig, "MCP_GATEWAY_ALLOWED_ORIGINS" | "WEB_ORIGIN" | "MCP_GATEWAY_PUBLIC_URL">): Set<string> {
  return parseOriginList(config.MCP_GATEWAY_ALLOWED_ORIGINS, config.WEB_ORIGIN, config.MCP_GATEWAY_PUBLIC_URL);
}

export function isGatewayOriginAllowed(allowed: ReadonlySet<string>, origin: string): boolean {
  try {
    return allowed.has(new URL(origin).origin.toLowerCase());
  } catch {
    return false;
  }
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/** Replace every occurrence of `secret` (a value the gateway injected) in a tool result. */
function scrubValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, scrubValue(nested, secret)]));
  }
  return value;
}

export function slugifyToolsetName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return slug || "toolset";
}

export function registerMcpGatewayRoutes(deps: McpGatewayDeps) {
  const { app, config, store, mcpRegistry } = deps;
  const clientService = new McpClientService(store);
  const allowedOrigins = gatewayAllowedOrigins(config);
  const approvalWindowMs = config.MCP_GATEWAY_APPROVAL_WINDOW_MS ?? DEFAULT_MCP_GATEWAY_APPROVAL_WINDOW_MS;

  const sessions = new GatewaySessionManager({
    idleMs: config.MCP_GATEWAY_SESSION_IDLE_MS,
    maxSessions: config.MCP_GATEWAY_MAX_SESSIONS,
    createContext: () => ({ resolveSecret: deps.resolveSecret, runtimeState: new Map<string, unknown>() }),
    closeContext: async (context) => {
      const errors = await mcpRegistry.closeSessions(context);
      for (const error of errors) {
        app.log.warn({ err: deps.redact(error.message) }, "Failed to close MCP sessions of a gateway session");
      }
    },
    onEnded: async (session, reason) => {
      const client = await store.getMcpClient(session.clientId);
      const toolset = await store.getMcpToolset(session.toolsetId);
      await deps.auditRaw({
        category: "system",
        eventType: "mcp_gateway.session_ended",
        action: "delete",
        outcome: "success",
        actor: { type: "api_key", email: client?.name ?? null },
        resourceType: "mcp_toolset",
        resourceId: session.toolsetId,
        projectId: toolset?.projectId ?? null,
        metadata: { sessionId: session.id, clientId: session.clientId, reason, durationMs: Date.now() - session.createdAt }
      });
    }
  });
  sessions.start();
  app.addHook("onClose", async () => {
    await sessions.closeAll();
  });

  // ---------------------------------------------------------------------------
  // Transport helpers
  // ---------------------------------------------------------------------------

  /** DNS-rebinding guard: no Origin, or one of the configured / own origins. */
  const originAllowed = (request: FastifyRequest): boolean => {
    const origin = headerValue(request, "origin");
    return origin === undefined || isGatewayOriginAllowed(allowedOrigins, origin);
  };

  const httpError = (reply: FastifyReply, status: number, message: string, code: number = -32000) => {
    reply.code(status).header("content-type", "application/json").send(rpcError(null, code, message));
  };

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedClient | null> => {
    const header = headerValue(request, "authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const unauthorized = (message: string) => {
      reply.header("www-authenticate", 'Bearer realm="l2m-mcp"');
      httpError(reply, 401, message, -32001);
      return null;
    };
    if (!match) return unauthorized("A client token is required: send Authorization: Bearer <token>.");
    const verification = await clientService.verify(match[1]!);
    if (!verification.ok) {
      const reason =
        verification.reason === "revoked"
          ? "This client token has been revoked."
          : verification.reason === "expired"
            ? "This client token has expired."
            : "Invalid client token.";
      return unauthorized(reason);
    }
    return { client: verification.client, subject: await resolveMcpClientSubject(store, verification.client) };
  };

  /** Origin, credential, toolset and scope checks shared by every method on /mcp/:toolset. */
  const admit = async (
    request: FastifyRequest<{ Params: { toolset: string } }>,
    reply: FastifyReply
  ): Promise<{ auth: AuthenticatedClient; toolset: McpToolset } | null> => {
    if (!originAllowed(request)) {
      httpError(reply, 403, "Origin not allowed.");
      return null;
    }
    const auth = await authenticate(request, reply);
    if (!auth) return null;
    const toolset = await store.getMcpToolsetBySlug(request.params.toolset);
    if (!toolset || !toolset.enabled) {
      httpError(reply, 404, `Toolset '${request.params.toolset}' does not exist or is disabled.`);
      return null;
    }
    if (!auth.client.toolsetIds.includes(toolset.id)) {
      httpError(reply, 403, `This client token is not scoped to toolset '${toolset.slug}'.`, -32001);
      return null;
    }
    return { auth, toolset };
  };

  const productionWorkflow = async (id: string): Promise<Workflow | null> => (deps.loadProductionWorkflow ? deps.loadProductionWorkflow(id) : await store.getWorkflow(id));
  const catalogStore = {
    getWorkflow: productionWorkflow,
    listMcpServers: async () => await store.listMcpServers(),
    getMcpToolSnapshot: async (id: string) => await store.getMcpToolSnapshot(id),
    listMcpToolPolicies: async () => await store.listMcpToolPolicies(),
    listMcpToolClassifications: async (registryServerId?: string) => await store.listMcpToolClassifications(registryServerId)
  };
  const catalogFor = async (toolset: McpToolset, role: McpPolicyRole, clientId?: string): Promise<GatewayCatalog> =>
    await buildGatewayCatalog({ toolset, role, store: catalogStore, ...(clientId ? { clientId } : {}) });

  const shouldAuditReadOnly = (session: GatewaySession, toolName: string): boolean => {
    const mode = config.MCP_GATEWAY_AUDIT_READ_ONLY_CALLS;
    if (mode === "all") return true;
    if (mode === "none") return false;
    if (session.auditedReadOnlyTools.has(toolName)) return false;
    session.auditedReadOnlyTools.add(toolName);
    return true;
  };

  const auditToolCall = async (input: {
    session: GatewaySession;
    auth: AuthenticatedClient;
    toolset: McpToolset;
    toolName: string;
    kind: "workflow" | "server";
    readOnly: boolean;
    ok: boolean;
    durationMs: number;
    details: Record<string, unknown>;
  }) => {
    // Write tools, workflow tools and failures always; read-only tools per MCP_GATEWAY_AUDIT_READ_ONLY_CALLS.
    if (input.ok && input.readOnly && !shouldAuditReadOnly(input.session, input.toolName)) return;
    await deps.auditRaw({
      category: "system",
      eventType: "mcp_gateway.tool_called",
      action: "execute",
      outcome: input.ok ? "success" : "failure",
      actor: { type: "api_key", email: input.auth.client.name },
      resourceType: "mcp_toolset",
      resourceId: input.toolset.id,
      projectId: input.toolset.projectId,
      metadata: {
        tool: input.toolName,
        kind: input.kind,
        readOnly: input.readOnly,
        clientId: input.auth.client.id,
        role: input.auth.subject.role,
        sessionId: input.session.id,
        durationMs: input.durationMs,
        ...input.details
      }
    });
  };

  // ---------------------------------------------------------------------------
  // tools/call
  // ---------------------------------------------------------------------------

  const callServerTool = async (input: {
    session: GatewaySession;
    auth: AuthenticatedClient;
    toolset: McpToolset;
    tool: GatewayServerTool;
    args: Record<string, unknown>;
    signal: AbortSignal;
    progress: (progress: number, total: number | undefined, message: string) => void;
    /** Phase 12.4 — what the tool policy decided for this call (enforced and shadow), when a rule matched. */
    policyDecision?: McpToolPolicyDecisionRecord;
    /** Phase 12.4 — the gateway approval this call used, given back if the call is cancelled and then refused unsent. */
    approvalId?: string;
  }): Promise<McpCallToolResult | GatewayRetryLater> => {
    const { session, auth, toolset, tool, args, signal, policyDecision, approvalId } = input;
    let refused: GatewayRetryLater | null = null;
    let invocation: Promise<MCPToolResult> | undefined;
    const startedAt = new Date();
    input.progress(0, 1, `Calling ${tool.toolName} on ${tool.serverName}`);
    let ok = false;
    let errorText: string | null = null;
    let result: McpCallToolResult;
    let samplingUsage: { requests: number; inputTokens: number; outputTokens: number } | null = null;
    try {
      // Phase 10.7 — a delegated server acts with the client's owner's own account.
      const serverConfig = withDelegatedUser(await deps.resolveRegisteredMcpServer(tool.serverId), auth.subject);
      const adapter = mcpRegistry.get(serverConfig.serverId);
      const cancelled = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error("Cancelled by the client."));
        signal.addEventListener("abort", () => reject(new Error("Cancelled by the client.")), { once: true });
      });
      // Phase 10.5 — a gateway call has no person behind it and no attached
      // chat model: elicitation is declined, sampling runs only through the
      // server's default model and is counted on this call's telemetry row.
      const samplingTrace: McpSamplingTraceEntry[] = [];
      const sampling = deps.providerRegistry
        ? createMcpSamplingHandler({
            providerRegistry: deps.providerRegistry,
            resolveSecret: deps.resolveSecret,
            serverConfigs: [serverConfig],
            evaluatePolicy: async (subject) =>
              evaluateGatewaySampling(await store.listMcpToolPolicies(), {
                role: auth.subject.role,
                projectId: toolset.projectId ?? null,
                adapterId: serverConfig.serverId,
                registryServerId: tool.serverId,
                serverLabel: tool.serverName,
                clientId: auth.client.id,
                model: subject.toolName
              }),
            trace: samplingTrace,
            signal
          })
        : undefined;
      sampling?.beginCall(tool.toolName);
      const callContext: MCPExecutionContext = {
        ...session.mcpContext,
        onElicitation: async () => ({ action: "decline" }),
        ...(sampling ? { onSampling: sampling.onSampling } : {})
      };
      invocation = adapter.invokeTool(tool.toolName, args, serverConfig, callContext);
      invocation.catch(() => undefined);
      const outcome = await Promise.race([invocation, cancelled]);
      if (samplingTrace.length > 0) {
        samplingUsage = {
          requests: samplingTrace.length,
          inputTokens: samplingTrace.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
          outputTokens: samplingTrace.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0)
        };
      }
      // Every injected value, including each value of a secret bundle (Phase 10.6).
      const injected = secretValuesForScrub(serverConfig.secretRef ? await deps.resolveSecret(serverConfig.secretRef) : undefined);
      const scrub = (value: unknown) => injected.reduce<unknown>((current, secret) => scrubValue(current, secret), value);
      if (outcome.ok) {
        ok = true;
        result = toolSuccess(scrub(outcome.output));
      } else {
        errorText = truncate(deps.redact(String(scrub(outcome.error ?? `MCP tool '${tool.toolName}' failed.`))));
        result = toolError(errorText);
        if (isRuntimeRefusal(outcome.errorKind)) {
          refused = { retryLater: true, reason: outcome.errorKind, retryAfterMs: outcome.retryAfterMs ?? 0, message: errorText };
        }
      }
    } catch (error) {
      errorText = truncate(deps.redact(error instanceof Error ? error.message : String(error)));
      result = toolError(errorText);
      // Phase 12.4 — cancelled while the call still waited for a rate limit or a concurrency slot: the call carries on
      // without the client. If the limiter then refuses it, it never reached the server, so the approval is given back.
      if (signal.aborted && approvalId && invocation !== undefined) {
        invocation.then(
          async (late) => {
            if (!late.ok && isRuntimeRefusal(late.errorKind)) await store.restoreMcpGatewayApproval(approvalId);
          },
          () => undefined
        ).catch((restoreError: unknown) => {
          app.log.warn({ err: deps.redact(restoreError instanceof Error ? restoreError.message : String(restoreError)) }, "MCP gateway approval put-back failed");
        });
      }
    }
    const durationMs = Date.now() - startedAt.getTime();
    try {
      await store.insertMcpToolCall({
        id: `mtc_${crypto.randomUUID()}`,
        executionId: `mcpgw_${crypto.randomUUID()}`,
        workflowId: "",
        nodeId: "",
        registryServerId: tool.serverId,
        adapterId: tool.adapterId,
        toolName: tool.toolName,
        startedAt: startedAt.toISOString(),
        durationMs,
        ok,
        error: errorText,
        turnInputTokens: null,
        turnOutputTokens: null,
        estimatedCostUsd: null,
        samplingRequests: samplingUsage?.requests ?? null,
        samplingInputTokens: samplingUsage?.inputTokens ?? null,
        samplingOutputTokens: samplingUsage?.outputTokens ?? null,
        source: "gateway",
        clientId: auth.client.id,
        ...(refused ? { rejection: refused.reason } : {}),
        ...(policyDecision ? { policyDecision } : {})
      });
    } catch (error) {
      app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "Failed to record MCP gateway telemetry");
    }
    await auditToolCall({
      session,
      auth,
      toolset,
      toolName: tool.name,
      kind: "server",
      readOnly: tool.readOnly,
      ok,
      durationMs,
      details: {
        serverId: tool.serverId,
        upstreamTool: tool.toolName,
        ...(samplingUsage ? { sampling: samplingUsage } : {}),
        ...(refused ? { rejection: refused.reason } : {}),
        ...(errorText ? { error: errorText } : {}),
        ...(policyDecision ? { policy: policyDecision } : {})
      }
    });
    if (refused) return refused;
    return result;
  };

  const callWorkflowTool = async (input: {
    session: GatewaySession;
    auth: AuthenticatedClient;
    toolset: McpToolset;
    tool: GatewayWorkflowTool;
    args: Record<string, unknown>;
    executionId: string;
    progress: (progress: number, total: number | undefined, message: string) => void;
  }): Promise<McpCallToolResult> => {
    const { session, auth, toolset, tool, args, executionId } = input;
    const startedAt = new Date();
    const workflow = await productionWorkflow(tool.workflowId);
    let outcome: GatewayWorkflowRunOutcome;
    if (!workflow) {
      const refusal = (await deps.productionRefusal?.(tool.workflowId)) ?? null;
      outcome = { status: "error", error: refusal ? `Workflow '${tool.workflowName}': ${refusal}` : `Workflow '${tool.workflowName}' no longer exists.` };
    } else {
      const total = workflow.nodes.length;
      let done = 0;
      input.progress(0, total, `Started workflow '${workflow.name}'`);
      try {
        outcome = await deps.runWorkflowTool({
          workflow,
          nodeId: tool.nodeId,
          toolName: tool.name,
          args,
          executionId,
          subject: auth.subject,
          client: auth.client,
          onNodeComplete: (event) => {
            done = Math.min(total, done + 1);
            const node = workflow.nodes.find((entry) => entry.id === event.nodeId);
            input.progress(done, total, `${node?.name ?? event.nodeId}: ${event.status}`);
          }
        });
      } catch (error) {
        outcome = { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    }
    const meta = { executionId };
    let result: McpCallToolResult;
    let errorText: string | null = null;
    if (outcome.status === "success") {
      result = toolSuccess(outcome.output ?? null, meta);
    } else if (outcome.status === "waiting_approval") {
      errorText = `The workflow is waiting for an approval (execution ${executionId}); it did not return a result.`;
      result = toolError(errorText, meta);
    } else if (outcome.status === "canceled") {
      errorText = "The workflow run was canceled.";
      result = toolError(errorText, meta);
    } else {
      errorText = truncate(deps.redact(outcome.error ?? "The workflow run failed."));
      result = toolError(errorText, meta);
    }
    const ok = errorText === null;
    const durationMs = Date.now() - startedAt.getTime();
    try {
      await store.insertMcpToolCall({
        id: `mtc_${crypto.randomUUID()}`,
        executionId,
        workflowId: tool.workflowId,
        nodeId: tool.nodeId,
        registryServerId: null,
        adapterId: GATEWAY_WORKFLOW_ADAPTER_ID,
        toolName: tool.name,
        startedAt: startedAt.toISOString(),
        durationMs,
        ok,
        error: errorText,
        turnInputTokens: null,
        turnOutputTokens: null,
        estimatedCostUsd: null,
        source: "gateway",
        clientId: auth.client.id
      });
    } catch (error) {
      app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "Failed to record MCP gateway telemetry");
    }
    await auditToolCall({
      session,
      auth,
      toolset,
      toolName: tool.name,
      kind: "workflow",
      readOnly: false,
      ok,
      durationMs,
      details: { workflowId: tool.workflowId, executionId, status: outcome.status, ...(errorText ? { error: errorText } : {}) }
    });
    return result;
  };

  // ---------------------------------------------------------------------------
  // Phase 12.4 — argument-aware tool policy for server tools
  // ---------------------------------------------------------------------------

  type GatewayPolicyGate =
    /** `approvalId`: the approval this call used, put back when the call is refused before it reaches the server. */
    | { outcome: "call"; policyDecision?: McpToolPolicyDecisionRecord; approvalId?: string }
    | { outcome: "respond"; response: JsonRpcResponse };

  /** Phase 12.4 — when each client's "too many pending requests" refusal was last audited (once per approval window). */
  const capAuditedAt = new Map<string, number>();

  /**
   * The tool policy for one server-tool call, with its arguments and the client as principal (the catalog already
   * left out tools a rule denies outright). A deny is a tool error. A require_approval rule holds the call back: the
   * client gets an "approval pending" JSON-RPC error naming the request, and once an admin approves it the identical
   * call (same client, server, tool and arguments) goes through once within MCP_GATEWAY_APPROVAL_WINDOW_MS. Once an
   * admin rejects it, identical retries are refused at once until the same window has passed since the decision.
   */
  const gatewayPolicyGate = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    tool: GatewayServerTool,
    args: Record<string, unknown>,
    requestId: JsonRpcRequest["id"]
  ): Promise<GatewayPolicyGate> => {
    const rules = await store.listMcpToolPolicies();
    if (rules.length === 0) return { outcome: "call" };
    const decision = evaluateToolForContext(
      {
        rules,
        classifications: await store.listMcpToolClassifications(tool.serverId),
        role: auth.subject.role,
        projectId: toolset.projectId ?? null,
        adapterId: tool.adapterId,
        registryServerId: tool.serverId,
        serverLabel: tool.serverName,
        clientId: auth.client.id
      },
      { name: tool.toolName, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
      "tool",
      { arguments: args }
    );
    const auditBase = {
      category: "system" as const,
      actor: { type: "api_key" as const, email: auth.client.name },
      resourceType: "mcp_toolset",
      resourceId: toolset.id,
      projectId: toolset.projectId
    };
    const callMetadata = {
      tool: tool.name,
      serverId: tool.serverId,
      upstreamTool: tool.toolName,
      clientId: auth.client.id,
      role: auth.subject.role,
      sessionId: session.id
    };
    if (!decision.allowed) {
      const record = policyDecisionRecord(decision.policy);
      await deps.auditRaw({
        ...auditBase,
        eventType: "mcp_gateway.tool_denied",
        action: "execute",
        outcome: "denied",
        metadata: { ...callMetadata, argsHash: gatewayArgsHash(args), ...(decision.ruleId ? { ruleId: decision.ruleId } : {}), ...(record ? { policy: record } : {}) }
      });
      return {
        outcome: "respond",
        response: rpcResult(requestId, toolError(decision.message ?? `MCP tool '${tool.toolName}' is blocked by policy.`))
      };
    }
    if (!decision.approval) return { outcome: "call", ...withRecord(policyDecisionRecord(decision.policy)) };

    const argsHash = gatewayArgsHash(args);
    const now = new Date();
    const callKey = { clientId: auth.client.id, serverId: tool.serverId, toolName: tool.toolName, argsHash };
    const approvalMetadata = { ...callMetadata, argsHash, ruleId: decision.approval.ruleId, ruleName: decision.approval.ruleName ?? null };

    // A rejection sticks: identical retries are refused until the window after the decision has passed.
    const rejection = await store.findBlockingMcpGatewayRejection(callKey, now.toISOString());
    if (rejection) {
      const rejected = rejection.approval;
      if (rejection.firstRefusal) {
        await deps.auditRaw({
          ...auditBase,
          eventType: "mcp_gateway.approval_refused_rejected",
          action: "execute",
          outcome: "denied",
          metadata: { ...approvalMetadata, approvalRequestId: rejected.id, decidedBy: rejected.decidedBy, retryAfter: rejected.expiresAt }
        });
      }
      const retryAfterMs = Math.max(0, Date.parse(rejected.expiresAt) - now.getTime());
      return {
        outcome: "respond",
        response: rpcError(
          requestId,
          JSON_RPC_ERRORS.approvalRejected,
          `Rejected: an admin rejected this exact call (request ${rejected.id})${rejected.decisionReason ? `: ${rejected.decisionReason}` : "."} Identical calls are refused until ${rejected.expiresAt}.`,
          {
            approvalRequestId: rejected.id,
            status: "rejected",
            ruleId: rejected.ruleId,
            ruleName: rejected.ruleName,
            reason: rejected.decisionReason,
            retryAfter: rejected.expiresAt,
            retryAfterMs,
            retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
          }
        )
      };
    }

    const usable = await store.findUsableMcpGatewayApproval(callKey, now.toISOString());
    if (usable) {
      if (await store.consumeMcpGatewayApproval(usable.id, now.toISOString())) {
        await deps.auditRaw({
          ...auditBase,
          eventType: "mcp_gateway.approval_used",
          action: "execute",
          outcome: "success",
          metadata: { ...callMetadata, approvalRequestId: usable.id, argsHash, ruleId: decision.approval.ruleId, decidedBy: usable.decidedBy }
        });
        return { outcome: "call", approvalId: usable.id, ...withRecord(policyDecisionRecord(decision.policy, "approved")) };
      }
      // An identical call used the approval a moment ago: say so rather than open a fresh request at once.
      return {
        outcome: "respond",
        response: rpcError(
          requestId,
          JSON_RPC_ERRORS.approvalPending,
          `Approval already used: an identical call just used approval ${usable.id}. Retry to ask for a new approval.`,
          { approvalRequestId: usable.id, status: "used", ruleId: decision.approval.ruleId, ruleName: decision.approval.ruleName ?? null, approvalWindowMs }
        )
      };
    }
    const preview = deps.redact(canonicalPolicyJson(args));
    const createdResult = await store.createMcpGatewayApproval(
      {
        id: `mga_${crypto.randomUUID()}`,
        clientId: auth.client.id,
        clientName: auth.client.name,
        toolsetId: toolset.id,
        projectId: toolset.projectId ?? null,
        serverId: tool.serverId,
        serverName: tool.serverName,
        toolName: tool.toolName,
        gatewayToolName: tool.name,
        argsHash,
        argsPreview: preview.length > GATEWAY_APPROVAL_PREVIEW_CHARS ? `${preview.slice(0, GATEWAY_APPROVAL_PREVIEW_CHARS - 1)}…` : preview,
        ruleId: decision.approval.ruleId,
        ruleName: decision.approval.ruleName ?? null,
        message: decision.approval.message,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + GATEWAY_APPROVAL_PENDING_MS).toISOString()
      },
      now.toISOString(),
      { maxPendingPerClient: GATEWAY_APPROVAL_MAX_PENDING_PER_CLIENT }
    );
    if (createdResult.capped) {
      const lastAudit = capAuditedAt.get(auth.client.id);
      if (lastAudit === undefined || now.getTime() - lastAudit >= approvalWindowMs) {
        capAuditedAt.set(auth.client.id, now.getTime());
        await deps.auditRaw({
          ...auditBase,
          eventType: "mcp_gateway.approval_capped",
          action: "execute",
          outcome: "denied",
          metadata: { ...approvalMetadata, maxPending: GATEWAY_APPROVAL_MAX_PENDING_PER_CLIENT }
        });
      }
      return {
        outcome: "respond",
        response: rpcError(
          requestId,
          JSON_RPC_ERRORS.retryLater,
          `Too many approval requests: this client already has ${GATEWAY_APPROVAL_MAX_PENDING_PER_CLIENT} waiting for an admin. Retry once some are decided.`,
          {
            reason: "approval_requests_pending",
            maxPending: GATEWAY_APPROVAL_MAX_PENDING_PER_CLIENT,
            retryAfterMs: GATEWAY_APPROVAL_CAP_RETRY_MS,
            retryAfterSeconds: Math.ceil(GATEWAY_APPROVAL_CAP_RETRY_MS / 1000)
          }
        )
      };
    }
    const { approval, created } = createdResult;
    if (created) {
      await deps.auditRaw({
        ...auditBase,
        eventType: "mcp_gateway.approval_requested",
        action: "execute",
        outcome: "denied",
        metadata: { ...callMetadata, approvalRequestId: approval.id, argsHash, ruleId: decision.approval.ruleId, ruleName: decision.approval.ruleName ?? null }
      });
    }
    return {
      outcome: "respond",
      response: rpcError(
        requestId,
        JSON_RPC_ERRORS.approvalPending,
        `Approval pending: ${decision.approval.message} Ask an admin to approve request ${approval.id}, then retry the same call with the same arguments.`,
        {
          approvalRequestId: approval.id,
          status: "pending",
          ruleId: decision.approval.ruleId,
          ruleName: decision.approval.ruleName ?? null,
          expiresAt: approval.expiresAt,
          approvalWindowMs
        }
      )
    };
  };

  const withRecord = (record: McpToolPolicyDecisionRecord | undefined) => (record ? { policyDecision: record } : {});

  // ---------------------------------------------------------------------------
  // Request dispatch
  // ---------------------------------------------------------------------------

  const handleToolsCall = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    request: JsonRpcRequest,
    emit: Emit
  ): Promise<JsonRpcResponse | typeof SUPPRESSED> => {
    const params = asRecord(request.params);
    if (typeof params.name !== "string" || !params.name) {
      return rpcError(request.id, JSON_RPC_ERRORS.invalidParams, "tools/call needs a tool name in params.name.");
    }
    if (params.arguments !== undefined && (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments))) {
      return rpcError(request.id, JSON_RPC_ERRORS.invalidParams, "params.arguments must be an object.");
    }
    const args = asRecord(params.arguments);
    const name = params.name;
    const catalog = await catalogFor(toolset, auth.subject.role, auth.client.id);
    const tool = catalog.tools.find((entry) => entry.name === name);
    if (!tool) {
      const hidden = catalog.hidden.find((entry) => entry.name === name);
      if (!hidden) {
        return rpcError(request.id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${name}`);
      }
      await deps.auditRaw({
        category: "system",
        eventType: "mcp_gateway.tool_denied",
        action: "execute",
        outcome: "denied",
        actor: { type: "api_key", email: auth.client.name },
        resourceType: "mcp_toolset",
        resourceId: toolset.id,
        projectId: toolset.projectId,
        metadata: {
          tool: name,
          serverId: hidden.serverId,
          upstreamTool: hidden.toolName,
          clientId: auth.client.id,
          role: auth.subject.role,
          sessionId: session.id,
          ...(hidden.ruleId ? { ruleId: hidden.ruleId } : {})
        }
      });
      return rpcResult(request.id, toolError(hidden.message));
    }

    let policyDecision: McpToolPolicyDecisionRecord | undefined;
    let usedApprovalId: string | undefined;
    if (tool.kind === "server") {
      const gate = await gatewayPolicyGate(session, auth, toolset, tool, args, request.id);
      if (gate.outcome === "respond") return gate.response;
      policyDecision = gate.policyDecision;
      usedApprovalId = gate.approvalId;
    }

    const meta = asRecord(params._meta);
    const progressToken =
      typeof meta.progressToken === "string" || typeof meta.progressToken === "number" ? meta.progressToken : undefined;
    const progress = (value: number, total: number | undefined, message: string) => {
      if (progressToken === undefined) return;
      emit({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: value, ...(total !== undefined ? { total } : {}), message }
      });
    };

    const key = requestKey(request.id);
    const controller = new AbortController();
    const executionId = crypto.randomUUID();
    session.inFlight.set(key, {
      controller,
      ...(tool.kind === "workflow" ? { executionId } : {}),
      onCancel: async (reason) => {
        if (tool.kind === "workflow") {
          deps.cancelExecution(executionId, reason);
        } else {
          // Adapters cannot abort one call, so stop the session's servers; the next call starts them again.
          await mcpRegistry.closeSessions(session.mcpContext);
        }
      }
    });
    try {
      const result =
        tool.kind === "workflow"
          ? await callWorkflowTool({ session, auth, toolset, tool, args, executionId, progress })
          : await callServerTool({
              session,
              auth,
              toolset,
              tool,
              args,
              signal: controller.signal,
              progress,
              ...(policyDecision ? { policyDecision } : {}),
              ...(usedApprovalId ? { approvalId: usedApprovalId } : {})
            });
      // Phase 12.4 — refused before reaching the server (even when the client cancelled meanwhile): the approval it
      // used is still good for a retry. A call cancelled while still queued is handled in callServerTool.
      if (isRetryLater(result) && usedApprovalId) await store.restoreMcpGatewayApproval(usedApprovalId);
      if (controller.signal.aborted) return SUPPRESSED;
      if (isRetryLater(result)) {
        // Phase 10.7 — refused before reaching the server: a JSON-RPC error with a retry hint.
        return rpcError(request.id, JSON_RPC_ERRORS.retryLater, result.message, {
          reason: result.reason,
          retryAfterMs: result.retryAfterMs,
          retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000))
        });
      }
      return rpcResult(request.id, result);
    } finally {
      session.inFlight.delete(key);
      sessions.touch(session);
    }
  };

  const dispatch = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    request: JsonRpcRequest,
    emit: Emit
  ): Promise<JsonRpcResponse | typeof SUPPRESSED> => {
    try {
      switch (request.method) {
        case "ping":
          return rpcResult(request.id, {});
        case "initialize":
          return rpcError(request.id, JSON_RPC_ERRORS.invalidRequest, "This session is already initialized.");
        case "tools/list": {
          const params = asRecord(request.params);
          const offset = params.cursor === undefined ? 0 : decodeCursor(params.cursor);
          if (offset === null) {
            return rpcError(request.id, JSON_RPC_ERRORS.invalidParams, "Invalid cursor.");
          }
          const catalog = await catalogFor(toolset, auth.subject.role, auth.client.id);
          const page = catalog.tools.slice(offset, offset + TOOLS_PAGE_SIZE);
          const next = offset + TOOLS_PAGE_SIZE < catalog.tools.length ? encodeCursor(offset + TOOLS_PAGE_SIZE) : undefined;
          return rpcResult(request.id, { tools: page.map(toMcpToolDescriptor), ...(next ? { nextCursor: next } : {}) });
        }
        case "tools/call":
          return await handleToolsCall(session, auth, toolset, request, emit);
        default:
          return rpcError(request.id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${request.method}`);
      }
    } catch (error) {
      app.log.error({ err: deps.redact(error instanceof Error ? error.message : String(error)), method: request.method }, "MCP gateway request failed");
      return rpcError(request.id, JSON_RPC_ERRORS.internalError, "Internal error.");
    }
  };

  const handleNotification = async (session: GatewaySession, notification: JsonRpcNotification) => {
    if (notification.method === "notifications/initialized") {
      session.initialized = true;
      return;
    }
    if (notification.method === "notifications/cancelled") {
      const params = asRecord(notification.params);
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") return;
      const entry = session.inFlight.get(requestKey(requestId));
      if (!entry || entry.controller.signal.aborted) return;
      const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : "Cancelled by the MCP client.";
      entry.controller.abort(reason);
      try {
        await entry.onCancel?.(reason);
      } catch (error) {
        app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "MCP gateway cancellation cleanup failed");
      }
    }
  };

  const handleInitialize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    message: JsonRpcRequest
  ) => {
    const params = asRecord(message.params);
    const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
    const clientInfo = asRecord(params.clientInfo);
    let session: GatewaySession;
    try {
      session = await sessions.create({
        clientId: auth.client.id,
        toolsetId: toolset.id,
        protocolVersion,
        clientInfo: {
          ...(typeof clientInfo.name === "string" ? { name: clientInfo.name.slice(0, 200) } : {}),
          ...(typeof clientInfo.version === "string" ? { version: clientInfo.version.slice(0, 50) } : {})
        }
      });
    } catch (error) {
      if (error instanceof GatewaySessionLimitError) {
        reply.code(503).header("retry-after", "30").send(rpcError(message.id, -32000, error.message));
        return;
      }
      throw error;
    }
    await deps.auditRaw({
      category: "system",
      eventType: "mcp_gateway.session_started",
      action: "create",
      outcome: "success",
      actor: { type: "api_key", email: auth.client.name, ipAddress: request.ip ?? null },
      resourceType: "mcp_toolset",
      resourceId: toolset.id,
      projectId: toolset.projectId,
      metadata: {
        sessionId: session.id,
        clientId: auth.client.id,
        role: auth.subject.role,
        protocolVersion,
        clientInfo: session.clientInfo
      }
    });
    reply
      .code(200)
      .header("content-type", "application/json")
      .header("mcp-session-id", session.id)
      .send(
        rpcResult(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `l2m-${toolset.slug}`, title: toolset.name, version: SERVER_VERSION },
          ...(toolset.description ? { instructions: toolset.description } : {})
        })
      );
  };

  const writeSse = (reply: FastifyReply, payload: unknown) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  app.register(async (scope) => {
    // Parse JSON ourselves so malformed bodies get a JSON-RPC parse error.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      done(null, body);
    });

    scope.post<{ Params: { toolset: string } }>("/mcp/:toolset", async (request, reply) => {
      const admitted = await admit(request, reply);
      if (!admitted) return reply;
      const { auth, toolset } = admitted;
      const accept = headerValue(request, "accept");
      if (!acceptAllows(accept, "application/json") && !acceptAllows(accept, "text/event-stream")) {
        httpError(reply, 406, "Accept must allow application/json or text/event-stream.");
        return reply;
      }
      const versionHeader = headerValue(request, "mcp-protocol-version");
      if (versionHeader !== undefined && !isSupportedProtocolVersion(versionHeader)) {
        httpError(
          reply,
          400,
          `Unsupported MCP-Protocol-Version '${versionHeader}'. Supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`
        );
        return reply;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof request.body === "string" ? request.body : "");
      } catch {
        reply.code(400).send(rpcError(null, JSON_RPC_ERRORS.parseError, "Parse error: the body is not valid JSON."));
        return reply;
      }
      const isBatch = Array.isArray(parsed);
      const rawMessages: unknown[] = isBatch ? (parsed as unknown[]) : [parsed];
      if (rawMessages.length === 0) {
        reply.code(400).send(rpcError(null, JSON_RPC_ERRORS.invalidRequest, "Empty batch."));
        return reply;
      }
      const classified: ClassifiedMessage[] = rawMessages.map(classifyMessage);
      const sessionHeader = headerValue(request, "mcp-session-id");

      const initialize = classified.find(
        (entry): entry is Extract<ClassifiedMessage, { kind: "request" }> =>
          entry.kind === "request" && entry.message.method === "initialize"
      );
      if (initialize) {
        if (isBatch) {
          reply.code(400).send(rpcError(initialize.message.id, JSON_RPC_ERRORS.invalidRequest, "initialize must not be part of a batch."));
          return reply;
        }
        if (sessionHeader) {
          reply.code(400).send(rpcError(initialize.message.id, JSON_RPC_ERRORS.invalidRequest, "This request already belongs to a session; start a new one without Mcp-Session-Id."));
          return reply;
        }
        await handleInitialize(request, reply, auth, toolset, initialize.message);
        return reply;
      }

      if (!sessionHeader) {
        httpError(reply, 400, "Mcp-Session-Id header is required; send initialize first.");
        return reply;
      }
      const session = sessions.get(sessionHeader);
      if (!session || session.clientId !== auth.client.id || session.toolsetId !== toolset.id) {
        httpError(reply, 404, "Session not found; it ended or expired. Initialize a new session.");
        return reply;
      }
      sessions.touch(session);
      if (isBatch && !versionAllowsBatches(session.protocolVersion)) {
        reply.code(400).send(rpcError(null, JSON_RPC_ERRORS.invalidRequest, `Batches are not supported in protocol version ${session.protocolVersion}.`));
        return reply;
      }

      const responses: JsonRpcResponse[] = [];
      const requests: JsonRpcRequest[] = [];
      for (const entry of classified) {
        if (entry.kind === "notification") {
          await handleNotification(session, entry.message);
        } else if (entry.kind === "request") {
          requests.push(entry.message);
        } else if (entry.kind === "invalid") {
          responses.push(rpcError(entry.id, JSON_RPC_ERRORS.invalidRequest, `Invalid request: ${entry.reason}.`));
        }
      }
      if (requests.length === 0 && responses.length === 0) {
        reply.code(202).header("mcp-session-id", session.id).send();
        return reply;
      }

      const wantsStream =
        acceptAllows(accept, "text/event-stream") &&
        requests.some((entry) => {
          const meta = asRecord(asRecord(entry.params)._meta);
          return typeof meta.progressToken === "string" || typeof meta.progressToken === "number";
        });

      if (wantsStream) {
        // Headers set by hooks (CORS, security headers) are not flushed for a hijacked reply.
        const hookHeaders: Record<string, string | number | string[]> = {};
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) hookHeaders[name] = value;
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          ...hookHeaders,
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "mcp-session-id": session.id,
          "x-request-id": request.id
        });
        // Long tool calls can go quiet between progress notifications; the
        // comment frames keep proxies from dropping the stream.
        const stopHeartbeat = startSseHeartbeat(reply.raw, config.SSE_HEARTBEAT_INTERVAL_MS);
        try {
          for (const response of responses) writeSse(reply, response);
          const emit: Emit = (notification) => writeSse(reply, notification);
          await Promise.all(
            requests.map(async (entry) => {
              const response = await dispatch(session, auth, toolset, entry, emit);
              if (response !== SUPPRESSED) writeSse(reply, response);
            })
          );
        } finally {
          stopHeartbeat();
          if (!reply.raw.writableEnded) reply.raw.end();
        }
        return reply;
      }

      const noEmit: Emit = () => undefined;
      const results = await Promise.all(
        requests.map(async (entry) => {
          const response = await dispatch(session, auth, toolset, entry, noEmit);
          return response === SUPPRESSED
            ? rpcError(entry.id, JSON_RPC_ERRORS.requestCancelled, "Request cancelled.")
            : response;
        })
      );
      const all = [...responses, ...results];
      reply
        .code(200)
        .header("content-type", "application/json")
        .header("mcp-session-id", session.id)
        .send(isBatch ? all : all[0]);
      return reply;
    });

    // No server-initiated stream: the spec allows 405 for GET.
    scope.get<{ Params: { toolset: string } }>("/mcp/:toolset", async (request, reply) => {
      if (!originAllowed(request)) {
        httpError(reply, 403, "Origin not allowed.");
        return reply;
      }
      reply.code(405).header("allow", "POST, DELETE").send(rpcError(null, -32000, "This endpoint does not offer a server-initiated stream; use POST."));
      return reply;
    });

    scope.delete<{ Params: { toolset: string } }>("/mcp/:toolset", async (request, reply) => {
      const admitted = await admit(request, reply);
      if (!admitted) return reply;
      const sessionHeader = headerValue(request, "mcp-session-id");
      if (!sessionHeader) {
        httpError(reply, 400, "Mcp-Session-Id header is required.");
        return reply;
      }
      const session = sessions.get(sessionHeader);
      if (!session || session.clientId !== admitted.auth.client.id || session.toolsetId !== admitted.toolset.id) {
        httpError(reply, 404, "Session not found.");
        return reply;
      }
      await sessions.end(session.id, "deleted");
      reply.code(204).send();
      return reply;
    });
  });

  // ---------------------------------------------------------------------------
  // Admin API — toolsets
  // ---------------------------------------------------------------------------

  const gatewayBaseUrl = config.MCP_GATEWAY_PUBLIC_URL.replace(/\/+$/, "") || null;

  const toolsetView = async (toolset: McpToolset) => {
    const servers = new Map((await store.listMcpServers()).map((server) => [server.id, server]));
    return {
      ...toolset,
      endpointPath: `/mcp/${toolset.slug}`,
      members: await mapAsync(toolset.members, async (member) => {
        if (member.kind === "workflow") {
          const workflow = await store.getWorkflow(member.workflowId);
          return { ...member, label: workflow?.name ?? member.workflowId, missing: !workflow };
        }
        const server = servers.get(member.serverId);
        return { ...member, label: server?.name ?? member.serverId, missing: !server };
      }),
      activeSessions: sessions.count((session) => session.toolsetId === toolset.id)
    };
  };

  type MemberInput = z.infer<typeof mcpToolsetMemberInputSchema>;

  const validateMembers = async (members: MemberInput[], reply: FastifyReply): Promise<McpToolsetMemberSpec[] | null> => {
    const seen = new Set<string>();
    const result: McpToolsetMemberSpec[] = [];
    for (const member of members) {
      if (member.kind === "workflow") {
        const workflow = await store.getWorkflow(member.workflowId);
        if (!workflow) {
          reply.code(400).send({ error: `Workflow '${member.workflowId}' does not exist` });
          return null;
        }
        if (!workflow.nodes.some((node) => node.type === "mcp_server_trigger")) {
          reply.code(400).send({ error: `Workflow '${workflow.name}' has no "Expose as MCP Tool" trigger` });
          return null;
        }
        const key = `workflow:${member.workflowId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ kind: "workflow", workflowId: member.workflowId });
      } else {
        if (!await store.getMcpServer(member.serverId)) {
          reply.code(400).send({ error: `MCP server '${member.serverId}' is not registered` });
          return null;
        }
        const toolGlob = member.toolGlob?.trim() ? member.toolGlob.trim() : null;
        const key = `server:${member.serverId}:${toolGlob ?? "*"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ kind: "server", serverId: member.serverId, toolGlob });
      }
    }
    return result;
  };

  const uniqueSlug = async (base: string): Promise<string> => {
    let candidate = base;
    let counter = 2;
    while (await store.getMcpToolsetBySlug(candidate)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    return candidate;
  };

  const auditToolset = async (
    request: FastifyRequest,
    user: SafeUser,
    eventType: string,
    action: "create" | "update" | "delete",
    toolset: McpToolset,
    metadata: Record<string, unknown> = {}
  ) => {
    await deps.auditUser(request, user, {
      category: "system",
      eventType,
      action,
      outcome: "success",
      resourceType: "mcp_toolset",
      resourceId: toolset.id,
      projectId: toolset.projectId,
      metadata: { slug: toolset.slug, name: toolset.name, members: toolset.members.length, ...metadata }
    });
  };

  const findToolset = async (id: string, reply: FastifyReply): Promise<McpToolset | null> => {
    const toolset = await store.getMcpToolset(id);
    if (!toolset) {
      reply.code(404).send({ error: "Toolset not found" });
      return null;
    }
    return toolset;
  };

  app.get("/api/mcp/toolsets", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    return {
      toolsets: await mapAsync(await store.listMcpToolsets(), toolsetView),
      gatewayBaseUrl,
      protocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS
    };
  });

  /** Workflows that can join a toolset: those with an "Expose as MCP Tool" trigger. */
  app.get("/api/mcp/toolsets/candidates", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const workflows: Array<{ id: string; name: string; projectId: string | null; tools: string[] }> = [];
    const readable = await deps.runAccess.readableWorkflowIds(user);
    const readableIds = readable && new Set(readable);
    for (const summary of await store.listWorkflows()) {
      if (readableIds && !readableIds.has(summary.id)) continue;
      const workflow = await store.getWorkflow(summary.id);
      if (!workflow) continue;
      const tools = workflow.nodes
        .filter((node) => node.type === "mcp_server_trigger")
        .map((node) => {
          const toolName = asRecord(node.config).toolName;
          return typeof toolName === "string" && toolName.trim() ? toolName.trim() : node.id;
        });
      if (tools.length > 0) {
        workflows.push({ id: workflow.id, name: workflow.name, projectId: workflow.projectId ?? null, tools });
      }
    }
    return { workflows };
  });

  app.get<{ Params: { id: string } }>("/api/mcp/toolsets/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const toolset = await findToolset(request.params.id, reply);
    if (!toolset) return reply;
    return { toolset: await toolsetView(toolset), gatewayBaseUrl };
  });

  app.get<{ Params: { id: string }; Querystring: { role?: string } }>("/api/mcp/toolsets/:id/preview", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const toolset = await findToolset(request.params.id, reply);
    if (!toolset) return reply;
    const parsedRole = request.query.role === undefined ? { success: true as const, data: user.role } : mcpPolicyRoleSchema.safeParse(request.query.role);
    if (!parsedRole.success) {
      reply.code(400);
      return { error: "role must be one of admin, builder, operator, viewer" };
    }
    const catalog = await catalogFor(toolset, parsedRole.data);
    return {
      toolsetId: toolset.id,
      role: parsedRole.data,
      projectId: toolset.projectId,
      tools: catalog.tools.map(toToolView),
      hidden: catalog.hidden.map(({ adapterId: _adapter, ...entry }) => entry),
      warnings: catalog.warnings
    };
  });

  app.post("/api/mcp/toolsets", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const parsed = mcpToolsetInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid toolset payload", details: parsed.error.issues };
    }
    if (parsed.data.projectId && !await store.getProject(parsed.data.projectId)) {
      reply.code(400);
      return { error: `Project '${parsed.data.projectId}' does not exist` };
    }
    if (parsed.data.slug && await store.getMcpToolsetBySlug(parsed.data.slug)) {
      reply.code(409);
      return { error: `A toolset with the slug '${parsed.data.slug}' already exists` };
    }
    const members = await validateMembers(parsed.data.members ?? [], reply);
    if (!members) return reply;
    const toolset = await store.createMcpToolset({
      id: `mts_${crypto.randomUUID()}`,
      slug: parsed.data.slug ?? await uniqueSlug(slugifyToolsetName(parsed.data.name)),
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      projectId: parsed.data.projectId ?? null,
      enabled: parsed.data.enabled ?? true,
      createdBy: user.email,
      members
    });
    await auditToolset(request, user, "mcp_toolset.created", "create", toolset);
    reply.code(201);
    return { toolset: await toolsetView(toolset) };
  });

  app.put<{ Params: { id: string } }>("/api/mcp/toolsets/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const existing = await findToolset(request.params.id, reply);
    if (!existing) return reply;
    const parsed = mcpToolsetUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid toolset payload", details: parsed.error.issues };
    }
    if (parsed.data.projectId && !await store.getProject(parsed.data.projectId)) {
      reply.code(400);
      return { error: `Project '${parsed.data.projectId}' does not exist` };
    }
    if (parsed.data.slug && parsed.data.slug !== existing.slug && await store.getMcpToolsetBySlug(parsed.data.slug)) {
      reply.code(409);
      return { error: `A toolset with the slug '${parsed.data.slug}' already exists` };
    }
    let members: McpToolsetMemberSpec[] | undefined;
    if (parsed.data.members !== undefined) {
      const validated = await validateMembers(parsed.data.members, reply);
      if (!validated) return reply;
      members = validated;
    }
    const { members: _members, ...fields } = parsed.data;
    const updated = (await store.updateMcpToolset(existing.id, { ...fields, ...(members ? { members } : {}) }))!;
    // A new URL or a disabled toolset ends the sessions bound to the old one.
    if (updated.slug !== existing.slug || !updated.enabled) {
      await sessions.endWhere((session) => session.toolsetId === existing.id, "toolset_removed");
    }
    await auditToolset(request, user, "mcp_toolset.updated", "update", updated, { fields: Object.keys(parsed.data) });
    return { toolset: await toolsetView(updated) };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/toolsets/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const existing = await findToolset(request.params.id, reply);
    if (!existing) return reply;
    await store.deleteMcpToolset(existing.id);
    await sessions.endWhere((session) => session.toolsetId === existing.id, "toolset_removed");
    await auditToolset(request, user, "mcp_toolset.deleted", "delete", existing);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/toolsets/:id/members", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const existing = await findToolset(request.params.id, reply);
    if (!existing) return reply;
    const parsed = mcpToolsetMemberInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid toolset member", details: parsed.error.issues };
    }
    const added = await validateMembers([parsed.data], reply);
    if (!added) return reply;
    const members = [...existing.members, ...added];
    const updated = (await store.updateMcpToolset(existing.id, { members }))!;
    await auditToolset(request, user, "mcp_toolset.member_added", "update", updated, { member: added[0] ?? null });
    reply.code(201);
    return { toolset: await toolsetView(updated) };
  });

  app.delete<{ Params: { id: string; memberId: string } }>("/api/mcp/toolsets/:id/members/:memberId", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const existing = await findToolset(request.params.id, reply);
    if (!existing) return reply;
    const member = existing.members.find((entry) => entry.id === request.params.memberId);
    if (!member) {
      reply.code(404);
      return { error: "Toolset member not found" };
    }
    const updated = (await store.updateMcpToolset(existing.id, {
      members: existing.members.filter((entry) => entry.id !== member.id)
    }))!;
    await auditToolset(request, user, "mcp_toolset.member_removed", "update", updated, { member });
    return { toolset: await toolsetView(updated) };
  });

  // ---------------------------------------------------------------------------
  // Admin API — clients
  // ---------------------------------------------------------------------------

  const clientStatus = (client: McpClient): "active" | "revoked" | "expired" => {
    if (client.revokedAt) return "revoked";
    if (client.expiresAt && new Date(client.expiresAt).getTime() <= Date.now()) return "expired";
    return "active";
  };

  const clientView = async (client: McpClient, usage?: { calls: number; errors: number; lastCalledAt: string | null }) => ({
    ...client,
    status: clientStatus(client),
    effectiveRole: (await resolveMcpClientSubject(store, client)).role,
    activeSessions: sessions.count((session) => session.clientId === client.id),
    usage: usage ? { calls: usage.calls, errors: usage.errors, lastCalledAt: usage.lastCalledAt } : { calls: 0, errors: 0, lastCalledAt: null }
  });

  app.get("/api/mcp/clients", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const since = new Date(Date.now() - MCP_TELEMETRY_WINDOWS["7d"]).toISOString();
    const usage = new Map((await store.summarizeMcpClientUsage(since)).map((row) => [row.clientId, row]));
    return {
      usageWindow: "7d",
      clients: await mapAsync(await store.listMcpClients(), (client) => clientView(client, usage.get(client.id)))
    };
  });

  app.post("/api/mcp/clients", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const parsed = mcpClientCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid client payload", details: parsed.error.issues };
    }
    const missing = await filterAsync(parsed.data.toolsetIds, async (id) => !(await store.getMcpToolset(id)));
    if (missing.length > 0) {
      reply.code(400);
      return { error: `Unknown toolset(s): ${missing.join(", ")}` };
    }
    if (roleRank(parsed.data.role) > roleRank(user.role)) {
      reply.code(403);
      return { error: `A ${user.role} cannot create a client with the ${parsed.data.role} role` };
    }
    if (parsed.data.expiresAt && new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
      reply.code(400);
      return { error: "expiresAt must be in the future" };
    }
    const { client, token } = await clientService.create({
      name: parsed.data.name,
      toolsetIds: parsed.data.toolsetIds,
      role: capRole(parsed.data.role, user.role),
      createdBy: user.id,
      createdByEmail: user.email,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt).toISOString() : null
    });
    await deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_client.created",
      action: "create",
      outcome: "success",
      resourceType: "mcp_client",
      resourceId: client.id,
      metadata: { name: client.name, role: client.role, toolsetIds: client.toolsetIds, tokenPrefix: client.tokenPrefix, expiresAt: client.expiresAt }
    });
    reply.code(201);
    // The only response that carries the token.
    return { client: await clientView(client), token };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/clients/:id/revoke", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const existing = await store.getMcpClient(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Client not found" };
    }
    const revoked = (await store.revokeMcpClient(existing.id))!;
    const closed = await sessions.endWhere((session) => session.clientId === existing.id, "revoked");
    if (!existing.revokedAt) {
      await deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_client.revoked",
        action: "update",
        outcome: "success",
        resourceType: "mcp_client",
        resourceId: existing.id,
        metadata: { name: existing.name, tokenPrefix: existing.tokenPrefix, closedSessions: closed }
      });
    }
    return { client: await clientView(revoked) };
  });

  // Phase 12.4 — gateway calls a require_approval rule held back. Admins decide; the client retries the call.
  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/mcp/gateway/approvals", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const status = request.query.status;
    if (status !== undefined && !GATEWAY_APPROVAL_STATUSES.includes(status as McpGatewayApproval["status"])) {
      reply.code(400);
      return { error: `status must be one of ${GATEWAY_APPROVAL_STATUSES.join(", ")}` };
    }
    const limit = request.query.limit !== undefined ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      reply.code(400);
      return { error: "limit must be an integer from 1 to 500" };
    }
    const approvals = await store.listMcpGatewayApprovals(
      { ...(status ? { status: status as McpGatewayApproval["status"] } : {}), ...(limit ? { limit } : {}) },
      new Date().toISOString()
    );
    return { approvals, approvalWindowMs };
  });

  const decideGatewayApproval = async (
    request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
    reply: FastifyReply,
    status: "approved" | "rejected"
  ) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const body = asRecord(request.body);
    if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== "string" || body.reason.length > 1000)) {
      reply.code(400);
      return { error: "reason must be a string of at most 1000 characters" };
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    const existing = await store.getMcpGatewayApproval(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Gateway approval request not found" };
    }
    const now = new Date();
    const decided = await store.decideMcpGatewayApproval(
      existing.id,
      {
        status,
        decidedBy: user.email,
        decidedAt: now.toISOString(),
        reason,
        // An approval is good for one identical call within the window; a rejection refuses identical calls for as long.
        expiresAt: new Date(now.getTime() + approvalWindowMs).toISOString()
      },
      now.toISOString()
    );
    if (!decided) {
      reply.code(409);
      const current = await store.getMcpGatewayApproval(existing.id);
      return { error: `This request is ${current?.status === "pending" ? "expired" : current?.status ?? "gone"}; it can no longer be decided.` };
    }
    await deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_gateway.approval_decided",
      action: "update",
      outcome: "success",
      resourceType: "mcp_toolset",
      resourceId: existing.toolsetId,
      projectId: existing.projectId,
      metadata: {
        approvalRequestId: existing.id,
        decision: status,
        clientId: existing.clientId,
        serverId: existing.serverId,
        upstreamTool: existing.toolName,
        argsHash: existing.argsHash,
        ruleId: existing.ruleId,
        ...(reason ? { reason } : {})
      }
    });
    return { approval: await store.getMcpGatewayApproval(existing.id) };
  };

  app.post<{ Params: { id: string }; Body: unknown }>("/api/mcp/gateway/approvals/:id/approve", async (request, reply) =>
    decideGatewayApproval(request, reply, "approved")
  );
  app.post<{ Params: { id: string }; Body: unknown }>("/api/mcp/gateway/approvals/:id/reject", async (request, reply) =>
    decideGatewayApproval(request, reply, "rejected")
  );

  app.get<{ Params: { id: string } }>("/api/mcp/clients/:id/usage", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const client = await store.getMcpClient(request.params.id);
    if (!client) {
      reply.code(404);
      return { error: "Client not found" };
    }
    const window = parseMcpTelemetryWindow((request.query as { window?: unknown } | undefined)?.window);
    if (!window) {
      reply.code(400);
      return { error: `window must be one of ${Object.keys(MCP_TELEMETRY_WINDOWS).join(", ")}` };
    }
    const since = new Date(Date.now() - MCP_TELEMETRY_WINDOWS[window]).toISOString();
    const rollup = rollupMcpToolCalls(await store.listMcpToolCallsForClient(client.id, since));
    return { clientId: client.id, window, since, lastUsedAt: client.lastUsedAt, ...rollup };
  });

  return { sessions };
}
