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
  headerLookupFrom,
  policyDecisionRecord,
  secretValuesForScrub,
  type MCPExecutionContext,
  type McpToolAccessDecision,
  type MCPRegistry
} from "@ai-orchestrator/mcp-sdk";
import {
  canonicalPolicyJson,
  recordedCallLabels,
  withImpliedSensitive,
  mcpClientCreateSchema,
  mcpClientUpdateSchema,
  effectiveGatewayRateLimit,
  normalizeGatewayRateLimit,
  mcpClientNetworkUpdateSchema,
  NETWORK_DENIED_MESSAGE,
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
  type DataLabels,
  type DestinationRef,
  type GatewayGuardProfileRef,
  type McpGatewaySessionView,
  type Workflow,
  mcpServerDestinationRef,
  credentialRotateBodySchema,
  KEY_ROTATION_GRACE_HOURS
} from "@ai-orchestrator/shared";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { createMcpSamplingHandler, referencesSecretIn, type GuardRunResolution } from "@ai-orchestrator/workflow-engine";
import type { GuardService } from "./services/guard-service.js";
import type { BudgetCheckContext, BudgetExceededError, BudgetService } from "./services/budget-service.js";
import { GatewayClientLimiter } from "./services/mcp-gateway-limits.js";
import { retryAfterSeconds } from "./run-helpers.js";
import { checkGatewayCall, type GatewayGuardChannel, type GatewayGuardOutcome } from "./services/mcp-gateway-guard.js";
import type { z } from "zod";
import { DEFAULT_MCP_GATEWAY_APPROVAL_WINDOW_MS, toolArgumentSummariesEnabled, type AppConfig } from "./config.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { evaluateToolForContext } from "./services/mcp-tool-policy.js";
import { openWorldMarking } from "./services/mcp-open-world.js";
import { policyReadsOpenWorld, withDelegatedUser } from "@ai-orchestrator/mcp-sdk";
import type { MCPToolResult, McpRuntimeRejection } from "@ai-orchestrator/shared";
import {
  buildGatewayCatalog,
  toMcpToolDescriptor,
  toToolView,
  type GatewayCatalog,
  type GatewayServerTool,
  type GatewayTool,
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
  DEFAULT_MCP_GATEWAY_LIST_TTL_MS,
  MODERN_GATEWAY_METHODS,
  gatewayDiscoverResult,
  gatewayServerInfo,
  gatewaySupportedVersions,
  isModernGatewayMessage,
  modernizeGatewayResponse,
  sortToolsByName,
  stripDescriptorHeaderAnnotations,
  validateModernGatewayMessage,
  type GatewayModernMode
} from "./services/mcp-gateway-modern.js";
import {
  GatewaySessionLimitError,
  GatewaySessionManager,
  gatewayPrincipalScope,
  noteSessionGuardBlock,
  raiseSessionLabels,
  sessionCallLabels,
  sessionLabelsView,
  type GatewayInFlight,
  type GatewaySession
} from "./services/mcp-gateway-sessions.js";
import { McpClientService, capRole, resolveMcpClientSubject, roleRank } from "./services/mcp-client-service.js";
import type { NetworkControls } from "./network-controls.js";
import { createMcpClientAdmission } from "./mcp-client-admission.js";
import { parseTrustProxy } from "./config.js";
import { MCP_TELEMETRY_WINDOWS, parseMcpTelemetryWindow, rollupMcpToolCalls } from "./services/mcp-tool-telemetry.js";
import { startSseHeartbeat } from "./sse-heartbeat.js";
import { createToolArgumentSummarizer, toolArgumentHashKey } from "./services/tool-argument-summary.js";
import type { Store } from "./db/store.js";
import { filterAsync, mapAsync } from "./async-array.js";
import { pageOfById, pageRequestFromQuery } from "./pagination.js";

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
    /** 12.6 — the toolset the call came through, for sampling rules scoped to toolsets. */
    toolsetId?: string;
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
      clientId: input.clientId,
      ...(input.toolsetId ? { toolsetId: input.toolsetId } : {})
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
  /**
   * 12.2 — the labels of the run's output, when known: the engine's (on this instance, or stored with a queue
   * worker's result), else `sensitive` when the workflow declares a sensitive source (tracking toolsets only).
   */
  labels?: Pick<DataLabels, "provenance" | "dataClasses">;
}

/** 12.2 — what a server tool's result carries: outside content, as in runs (and `sensitive` from a flagged secret). */
const SERVER_RESULT_LABELS: Pick<DataLabels, "provenance" | "dataClasses"> = { provenance: ["untrusted_external"], dataClasses: [] };

/**
 * 12.2 — the labels a tool rule's conditions read for a call: data classes count as `sensitive` too, as in runs.
 * Nothing scans gateway results, so a `sensitive` or data class the session does not hold is not tracked rather than
 * absent (`classesTracked: false`): it never lets an allow carve out, and a deny or approval on its absence still holds.
 */
function policyCallLabels(labels: DataLabels | undefined): { provenance: string[]; dataClasses: string[]; classesTracked: false } | undefined {
  if (!labels) return undefined;
  const implied = withImpliedSensitive(labels);
  return { provenance: [...implied.provenance], dataClasses: [...implied.dataClasses], classesTracked: false };
}


export interface McpGatewayDeps {
  app: FastifyInstance;
  config: AppConfig;
  store: Store;
  mcpRegistry: MCPRegistry;
  /** Phase 10.5 — answers `sampling/createMessage` with a server's default model; absent means sampling is refused. */
  providerRegistry?: ProviderRegistry;
  /**
   * 12.6 — the registry a sampling request of this call uses: `providerRegistry` checked against the model allowlist
   * of the toolset's project (null: app.ts applies the default project's list). Without it, `providerRegistry` as given.
   */
  samplingRegistryFor?: (scope: { projectId: string | null; toolsetId: string; clientId: string; sessionId: string }) => ProviderRegistry;
  resolveSecret: MCPExecutionContext["resolveSecret"];
  redact: (value: string) => string;
  resolveRegisteredMcpServer: (registryServerId: string) => Promise<MCPServerConfig>;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** 13.2 — step-up before creating a client (STEP_UP_MAX_AGE_MINUTES); false means the answer was sent. Absent = none. */
  requireStepUp?: (request: FastifyRequest, reply: FastifyReply, action: "mcp_client.create" | "mcp_client.rotate") => Promise<boolean>;
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
    /** 12.2 — what the client's session has collected (tracking toolsets only); the run's input carries it too. */
    sessionLabels?: Pick<DataLabels, "provenance" | "dataClasses">;
    /** 12.2 — the toolset tracks outside content per session: the outcome's labels are wanted, with a fallback. */
    tracksLabels?: boolean;
    /**
     * 12.6 — the toolset's and client's Guard profiles (pinned versions) when either has a binding: the run applies
     * them after its own profiles (tighten-only) and records them, so a retry or replay applies them again.
     */
    gatewayGuard?: { toolsetId: string; clientId: string; profiles: GatewayGuardProfileRef[] };
    /** 12.6 — the toolset the call came through: the run's usage counts toward the client and the toolset's project. */
    toolset: McpToolset;
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
  /** 12.2 — the ids of secrets flagged "sensitive output": a server that uses one returns sensitive results. */
  sensitiveSecretIds?: () => Promise<ReadonlySet<string>>;
  /** 12.6 — Guard per toolset and per client. Absent: the gateway runs no Guard (as before 12.6). */
  guard?: GuardService;
  /**
   * 12.6 — budgets: a `block` budget of the client, the toolset's project or the deployment that is used up refuses
   * the call; sampling cost counts toward them. Absent: no budget checks.
   */
  budgets?: Pick<BudgetService, "checkBlock" | "recordGatewayUsage" | "clientUsage">;
  /** 12.6 — the cost of a sampling request (the usage pricing table); null when the model has no price. */
  priceSampling?: (providerId: string, model: string, inputTokens: number, outputTokens: number) => number | null;
  /** 12.6 — per-client rate limits; absent: counted in this process (`GatewayClientLimiter` without a shared store). */
  limiter?: GatewayClientLimiter;
  /**
   * 13.2 — per-client address lists and client certificates. Absent: no forwarded certificate is read, so a client
   * that pins certificates is refused, and client address lists are checked in enforce mode.
   */
  network?: NetworkControls;
  /**
   * 13.1 — the instances share a database (Postgres with HA_ENABLED=true). MCP 2026-07-28 callers are then not served
   * on toolsets that track outside content per session: their label mark would stay on one instance.
   */
  clusterMode?: boolean;
}

/**
 * MCP 2026-07-28 — what a modern call adds to the dispatch: a key for its in-flight entry that is unique to its HTTP
 * request (modern callers share one principal state, and two of their conversations may reuse a JSON-RPC id), and
 * the signal that the caller closed the connection, which cancels the call.
 */
interface ModernCallScope {
  inFlightKey: string;
  disconnect: AbortSignal;
}

/** 12.6 — the Guard stack a gateway call runs under, when a toolset or client binding applies. */
interface GatewayGuardStackForCall {
  resolution: GuardRunResolution;
  refs: GatewayGuardProfileRef[];
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
  // MCP 2026-07-28 — modern callers are served only when switched on (D2: off by default).
  const modernMode: GatewayModernMode = config.MCP_GATEWAY_MODERN_PROTOCOL === "on" ? "on" : "off";
  const listTtlMs = config.MCP_GATEWAY_LIST_TTL_MS ?? DEFAULT_MCP_GATEWAY_LIST_TTL_MS;
  // Phase 12.4 — a safe summary of each call's arguments and the client's role on its telemetry row (unless switched off).
  const summarizeArguments = createToolArgumentSummarizer({
    enabled: toolArgumentSummariesEnabled(config),
    hashKey: toolArgumentHashKey(config.SECRET_MASTER_KEY_BASE64)
  });
  const callContext = (args: Record<string, unknown>, inputSchema: Record<string, unknown>, auth: AuthenticatedClient, toolset: McpToolset) =>
    summarizeArguments
      ? {
          argsSummary: summarizeArguments(args, inputSchema),
          subjectRole: auth.subject.role,
          subjectSource: auth.subject.source,
          projectId: toolset.projectId ?? null
        }
      : {};

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
      limitAuditedAt.delete(session.id);
      // Principal states of modern callers are not sessions: no session_started, so no session_ended either.
      if (session.era === "modern") return;
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

  // 12.6 — per-client rate limits (none unless a client or toolset has one).
  const limiter = deps.limiter ?? new GatewayClientLimiter();
  /** 12.6 — when each session's last rate-limit or budget refusal was audited (at most once a minute per session). */
  const limitAuditedAt = new Map<string, number>();
  const LIMIT_AUDIT_EVERY_MS = 60_000;
  /**
   * Who a call came from in audit metadata: a legacy session's id, or a modern caller's principal scope and the
   * version of its request (modern callers have no session).
   */
  const scopeMetadata = (session: GatewaySession): Record<string, unknown> =>
    session.era === "modern" ? { principalScope: session.principalScope, protocolVersion: session.protocolVersion } : { sessionId: session.id };
  const auditLimitRefusal = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    eventType: "mcp_gateway.rate_limited" | "mcp_gateway.budget_blocked",
    metadata: Record<string, unknown>
  ) => {
    const now = Date.now();
    const last = limitAuditedAt.get(session.id);
    if (last !== undefined && now - last < LIMIT_AUDIT_EVERY_MS) return;
    limitAuditedAt.set(session.id, now);
    await deps.auditRaw({
      category: "system",
      eventType,
      action: "execute",
      outcome: "denied",
      actor: { type: "api_key", email: auth.client.name },
      resourceType: "mcp_toolset",
      resourceId: toolset.id,
      projectId: toolset.projectId,
      metadata: { clientId: auth.client.id, ...scopeMetadata(session), ...metadata }
    });
  };

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

  const clientAdmission = createMcpClientAdmission({ ...(deps.network ? { network: deps.network } : {}), auditRaw: deps.auditRaw });

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
    // 13.2 — a client that pins certificates needs its token AND one of its certificates.
    const certificateRefusal = await clientAdmission.certificateRefusal(request, verification.client);
    if (certificateRefusal) return unauthorized(certificateRefusal);
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
    // 13.2 — the client's own address list (empty = any address).
    if (!(await clientAdmission.addressAdmitted(request, auth.client))) {
      httpError(reply, 403, NETWORK_DENIED_MESSAGE, -32001);
      return null;
    }
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
    listMcpToolClassifications: async (registryServerId?: string) => await store.listMcpToolClassifications(registryServerId),
    listMcpToolOpenWorldOverrides: async (registryServerId?: string) => await store.listMcpToolOpenWorldOverrides(registryServerId),
    listDataDestinations: async () => await store.listDataDestinations()
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
        ...scopeMetadata(input.session),
        durationMs: input.durationMs,
        ...input.details
      }
    });
  };

  // ---------------------------------------------------------------------------
  // 12.2 — session labels (toolsets that track outside content per session)
  // ---------------------------------------------------------------------------

  /** Audited once per session: the first time it carries outside content or sensitive data. */
  const auditFirstRaise = async (session: GatewaySession, auth: AuthenticatedClient, toolset: McpToolset, tool: string | null, reason: "tool_result" | "results_before_tracking") => {
    if (session.labels.raiseAudited) return;
    session.labels.raiseAudited = true;
    await deps.auditRaw({
      category: "system",
      eventType: "mcp_gateway.session_labels_raised",
      action: "update",
      outcome: "success",
      actor: { type: "api_key", email: auth.client.name },
      resourceType: "mcp_toolset",
      resourceId: toolset.id,
      projectId: toolset.projectId,
      metadata: { ...scopeMetadata(session), clientId: auth.client.id, tool, reason, labels: sessionLabelsView(session.labels) }
    });
  };

  /**
   * The labels a call is checked with. Undefined when the toolset does not track: the call is then checked without
   * labels, exactly as before. Nothing in the client's request is read.
   */
  const labelsForCall = async (session: GatewaySession, auth: AuthenticatedClient, toolset: McpToolset): Promise<DataLabels | undefined> => {
    if (!toolset.trackSessionLabels) return undefined;
    const { labels, raised } = sessionCallLabels(session.labels);
    if (raised) await auditFirstRaise(session, auth, toolset, null, "results_before_tracking");
    return labels;
  };

  /** A result went back to the client (or may have): its labels join the session's mark, which never goes down. */
  const noteResult = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    tool: string,
    labels: Pick<DataLabels, "provenance" | "dataClasses">
  ) => {
    if (raiseSessionLabels(session.labels, labels, toolset.trackSessionLabels)) await auditFirstRaise(session, auth, toolset, tool, "tool_result");
  };

  /** A server's results are sensitive when its secret or connection uses a secret flagged "sensitive output". */
  const serverResultLabels = async (serverConfig: MCPServerConfig | null): Promise<Pick<DataLabels, "provenance" | "dataClasses">> => {
    if (!serverConfig || !deps.sensitiveSecretIds) return SERVER_RESULT_LABELS;
    const flagged = await deps.sensitiveSecretIds();
    if (flagged.size === 0 || !referencesSecretIn({ secretRef: serverConfig.secretRef, connection: serverConfig.connection }, flagged)) return SERVER_RESULT_LABELS;
    return { provenance: ["untrusted_external", "sensitive"], dataClasses: [] };
  };

  // ---------------------------------------------------------------------------
  // 12.6 — Guard per toolset and per client
  // ---------------------------------------------------------------------------

  /**
   * The content rules stack for one call: undefined when nothing applies (no toolset, client or enforced project
   * binding, and no deployment destination rules), so the call runs exactly as before. A failed read throws: the caller
   * refuses the call (fail closed) rather than guess whether a binding applies.
   */
  const guardStackFor = async (auth: AuthenticatedClient, toolset: McpToolset): Promise<GatewayGuardStackForCall | undefined> => {
    if (!deps.guard) return undefined;
    const { resolution, refs } = await deps.guard.resolveGateway({ toolsetId: toolset.id, clientId: auth.client.id, projectId: toolset.projectId });
    return resolution.stack.length > 0 ? { resolution, refs } : undefined;
  };

  interface GuardCallScope {
    session: GatewaySession;
    auth: AuthenticatedClient;
    toolset: McpToolset;
    tool: GatewayTool;
    /** The call's synthetic `mcpgw_*` id: the gateway's Guard events are recorded under it. */
    callExecutionId: string;
    /** A workflow tool's run (absent when Guard blocked its arguments: no run started). */
    runExecutionId?: string;
    callLabels?: DataLabels;
  }

  /** What Guard knows of a tool: a server tool's server and upstream name, or a workflow tool's workflow. */
  const guardToolOf = (tool: GatewayTool) =>
    tool.kind === "server"
      ? { serverId: tool.serverId, toolName: tool.toolName, inputSchema: tool.inputSchema }
      : { serverId: tool.workflowId, toolName: tool.name, inputSchema: tool.inputSchema };

  const guardCheck = async (
    stack: GatewayGuardStackForCall,
    channel: GatewayGuardChannel,
    scope: GuardCallScope,
    content: unknown,
    extra: { destination?: DestinationRef | null } = {}
  ): Promise<GatewayGuardOutcome> =>
    await checkGatewayCall({
      guard: deps.guard!,
      context: {
        executionId: scope.callExecutionId,
        toolsetId: scope.toolset.id,
        clientId: scope.auth.client.id,
        projectId: scope.toolset.projectId,
        ...(scope.tool.kind === "workflow" ? { workflowId: scope.tool.workflowId } : {})
      },
      resolution: stack.resolution,
      channel,
      toolName: scope.tool.name,
      tool: guardToolOf(scope.tool),
      content,
      subject: scope.auth.subject,
      resolveSecret: deps.resolveSecret,
      ...(extra.destination !== undefined ? { destination: extra.destination } : {}),
      ...(scope.callLabels ? { callLabels: scope.callLabels } : {}),
      logger: (message, metadata) => app.log.warn({ metadata }, message)
    });

  /** A Guard block: counted on the session and audited (the reason is short and names categories only). */
  const guardBlocked = async (
    verdict: Extract<GatewayGuardOutcome, { action: "block" }>,
    channel: GatewayGuardChannel,
    scope: Omit<GuardCallScope, "callLabels">
  ): Promise<McpCallToolResult> => {
    const reason = deps.redact(verdict.reason);
    noteSessionGuardBlock(scope.session, { tool: scope.tool.name, channel, reason });
    await deps.auditRaw({
      category: "system",
      eventType: "mcp_gateway.guard_blocked",
      action: "execute",
      outcome: "denied",
      actor: { type: "api_key", email: scope.auth.client.name },
      resourceType: "mcp_toolset",
      resourceId: scope.toolset.id,
      projectId: scope.toolset.projectId,
      metadata: {
        tool: scope.tool.name,
        ...(scope.tool.kind === "server" ? { serverId: scope.tool.serverId, upstreamTool: scope.tool.toolName } : { workflowId: scope.tool.workflowId }),
        ...(scope.runExecutionId ? { runExecutionId: scope.runExecutionId } : {}),
        channel,
        clientId: scope.auth.client.id,
        role: scope.auth.subject.role,
        ...scopeMetadata(scope.session),
        executionId: scope.callExecutionId,
        categories: verdict.categories,
        profiles: verdict.profiles,
        reason
      }
    });
    return toolError(reason);
  };

  /** A run's output with known secret values masked (the same masking the gateway applies to error text). */
  const scrubOutput = (output: unknown): unknown => {
    if (typeof output === "string") return deps.redact(output);
    if (Array.isArray(output)) return output.map(scrubOutput);
    if (output && typeof output === "object") {
      return Object.fromEntries(Object.entries(output as Record<string, unknown>).map(([key, value]) => [key, scrubOutput(value)]));
    }
    return output;
  };

  /**
   * 12.6 — Guard on a call's arguments, before anything reaches the server or the workflow run (and, for a server
   * tool held for approval, before an approval is asked for or used). A block answers with a tool error; a rewrite
   * sends the rewritten arguments. A server tool's destination rules see where the call goes; a workflow tool's run
   * sends nothing out itself (its nodes are checked in the run).
   */
  const guardArguments = async (
    stack: GatewayGuardStackForCall,
    scope: GuardCallScope,
    args: Record<string, unknown>
  ): Promise<{ blocked: McpCallToolResult } | { args: Record<string, unknown> }> => {
    let destination: DestinationRef | null | undefined = null;
    if (scope.tool.kind === "server") {
      try {
        const server = await deps.resolveRegisteredMcpServer(scope.tool.serverId);
        destination = mcpServerDestinationRef({ serverId: server.serverId, registryServerId: scope.tool.serverId, connection: server.connection });
      } catch {
        // The call itself fails on the same lookup and answers with its error.
        destination = undefined;
      }
    }
    const verdict = await guardCheck(stack, "tool_arguments", scope, args, destination !== undefined ? { destination } : {});
    if (verdict.action === "block") return { blocked: await guardBlocked(verdict, "tool_arguments", scope) };
    return { args: verdict.action === "rewrite" ? (verdict.content as Record<string, unknown>) : args };
  };

  // ---------------------------------------------------------------------------
  // tools/call
  // ---------------------------------------------------------------------------

  /** 12.6 — what a call's sampling requests cost: the priced ones summed; null when none of them has a price. */
  const samplingCost = (trace: McpSamplingTraceEntry[]): number | null => {
    if (!deps.priceSampling) return null;
    let total: number | null = null;
    for (const entry of trace) {
      if (!entry.ok || !entry.providerId || !entry.model) continue;
      const cost = deps.priceSampling(entry.providerId, entry.model, entry.inputTokens ?? 0, entry.outputTokens ?? 0);
      if (cost !== null) total = (total ?? 0) + cost;
    }
    return total;
  };

  /**
   * 12.6 — who a gateway call's budgets are matched against: the client and the toolset's project and, for a workflow
   * tool, the workflow, its project and the name its run is recorded under (as the run's own admission would match).
   * A workflow tool's run is not checked again when it starts (one check per call).
   */
  const budgetContext = (auth: AuthenticatedClient, toolset: McpToolset, workflow: { workflowId: string; projectId: string | null } | null): BudgetCheckContext => ({
    workflowId: workflow?.workflowId ?? null,
    projectId: workflow?.projectId ?? null,
    userEmail: null,
    userId: workflow ? `mcp-client:${auth.client.name}` : null,
    client: { id: auth.client.id, name: auth.client.name },
    toolsetProjectId: toolset.projectId ?? null
  });

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
    /** 12.2 — the labels the call was checked with (tracking toolsets only), recorded on its telemetry row. */
    callLabels?: DataLabels;
    /**
     * 12.6 — the toolset's and client's Guard stack; absent when neither has a binding (no Guard, as before). The
     * arguments were checked already (`args` is what Guard let through); the result is checked here.
     */
    guardStack?: GatewayGuardStackForCall;
    /** The call's synthetic execution id: its telemetry row and (12.6) its Guard events share it. */
    callExecutionId: string;
  }): Promise<McpCallToolResult | GatewayRetryLater> => {
    const { session, auth, toolset, tool, args, signal, policyDecision, approvalId, callLabels, guardStack, callExecutionId } = input;
    let resolvedServer: MCPServerConfig | null = null;
    let refused: GatewayRetryLater | null = null;
    let invocation: Promise<MCPToolResult> | undefined;
    const startedAt = new Date();
    input.progress(0, 1, `Calling ${tool.toolName} on ${tool.serverName}`);
    let ok = false;
    let errorText: string | null = null;
    let result: McpCallToolResult;
    let samplingUsage: { requests: number; inputTokens: number; outputTokens: number; costUsd: number | null } | null = null;
    // 12.6 — set when Guard blocked the result (the server was called).
    let guardResultBlocked: Extract<GatewayGuardOutcome, { action: "block" }> | null = null;
    try {
      // Phase 10.7 — a delegated server acts with the client's owner's own account.
      const serverConfig = withDelegatedUser(await deps.resolveRegisteredMcpServer(tool.serverId), auth.subject);
      resolvedServer = serverConfig;
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
            providerRegistry: deps.samplingRegistryFor
              ? deps.samplingRegistryFor({ projectId: toolset.projectId ?? null, toolsetId: toolset.id, clientId: auth.client.id, sessionId: session.id })
              : deps.providerRegistry,
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
                toolsetId: toolset.id,
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
          outputTokens: samplingTrace.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
          costUsd: samplingCost(samplingTrace)
        };
      }
      // Every injected value, including each value of a secret bundle (Phase 10.6).
      const injected = secretValuesForScrub(serverConfig.secretRef ? await deps.resolveSecret(serverConfig.secretRef) : undefined);
      const scrub = (value: unknown) => injected.reduce<unknown>((current, secret) => scrubValue(current, secret), value);
      if (outcome.ok) {
        ok = true;
        // 12.6 — Guard reads the result only after the gateway's own secret values are scrubbed out of it.
        let output = scrub(outcome.output);
        if (guardStack) {
          const verdict = await guardCheck(guardStack, "tool_result", { session, auth, toolset, tool, callExecutionId, callLabels }, output);
          if (verdict.action === "block") guardResultBlocked = verdict;
          else if (verdict.action === "rewrite") output = verdict.content;
        }
        result = guardResultBlocked ? toolError(guardResultBlocked.reason) : toolSuccess(output);
      } else {
        errorText = truncate(deps.redact(String(scrub(outcome.error ?? `MCP tool '${tool.toolName}' failed.`))));
        if (isRuntimeRefusal(outcome.errorKind)) {
          refused = { retryLater: true, reason: outcome.errorKind, retryAfterMs: outcome.retryAfterMs ?? 0, message: errorText };
        } else if (guardStack) {
          // 12.6 — the server's error text reaches the client like a result: it is checked like one.
          const verdict = await guardCheck(guardStack, "tool_result", { session, auth, toolset, tool, callExecutionId, callLabels }, errorText);
          if (verdict.action === "block") guardResultBlocked = verdict;
          else if (verdict.action === "rewrite") errorText = truncate(deps.redact(typeof verdict.content === "string" ? verdict.content : JSON.stringify(verdict.content)));
        }
        result = toolError(guardResultBlocked ? guardResultBlocked.reason : errorText);
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
        executionId: callExecutionId,
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
        // 12.6 — what the sampling requests cost (the usage pricing table); null without sampling or a priced model.
        estimatedCostUsd: samplingUsage?.costUsd ?? null,
        samplingRequests: samplingUsage?.requests ?? null,
        samplingInputTokens: samplingUsage?.inputTokens ?? null,
        samplingOutputTokens: samplingUsage?.outputTokens ?? null,
        source: "gateway",
        clientId: auth.client.id,
        toolsetId: toolset.id,
        ...(refused ? { rejection: refused.reason } : {}),
        ...(policyDecision ? { policyDecision } : {}),
        ...recordedLabels(callLabels),
        ...callContext(args, tool.inputSchema, auth, toolset)
      });
    } catch (error) {
      app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "Failed to record MCP gateway telemetry");
    }
    // 12.6 — sampling spend counts toward the client's, the toolset project's and the global budgets: their alerts.
    if (deps.budgets && samplingUsage && (samplingUsage.inputTokens + samplingUsage.outputTokens > 0 || (samplingUsage.costUsd ?? 0) > 0)) {
      try {
        await deps.budgets.recordGatewayUsage({ ...budgetContext(auth, toolset, null), executionId: callExecutionId });
      } catch (error) {
        app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "MCP gateway budget alert evaluation failed");
      }
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
        ...(policyDecision ? { policy: policyDecision } : {}),
        ...(guardResultBlocked ? { guard: { blocked: true, channel: "tool_result", executionId: callExecutionId } } : {})
      }
    });
    if (guardResultBlocked) await guardBlocked(guardResultBlocked, "tool_result", { session, auth, toolset, tool, callExecutionId });
    // 12.2 — the server was asked: what it answered (a result or an error text) goes back to the client, so it counts
    // as outside content (fail closed, also when the client cancelled). A call the runtime guard refused never
    // reached the server and carries nothing.
    if (invocation !== undefined && !refused && !toolset.trackSessionLabels) {
      // Not tracked: only note that a result came back (turning tracking on later counts it), with no lookup.
      raiseSessionLabels(session.labels, SERVER_RESULT_LABELS, false);
    } else if (invocation !== undefined && !refused) {
      let labels = SERVER_RESULT_LABELS;
      try {
        labels = await serverResultLabels(resolvedServer);
      } catch (error) {
        app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "Could not read the sensitive output secrets for a gateway call");
      }
      await noteResult(session, auth, toolset, tool.name, labels);
    }
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
    callLabels?: DataLabels;
    /** 12.6 — the Guard stack: it travels with the run and checks its answer (`args` already passed Guard). */
    guardStack?: GatewayGuardStackForCall;
    /** 12.6 — the call's `mcpgw_*` id for the gateway's Guard events. */
    callExecutionId: string;
  }): Promise<McpCallToolResult> => {
    const { session, auth, toolset, tool, args, executionId, callLabels, guardStack, callExecutionId } = input;
    const startedAt = new Date();
    const workflow = await productionWorkflow(tool.workflowId);
    // 12.2 — `callLabels`: the labels the call was checked with (tracking toolsets only); `ran`: the run started.
    let ran = false;
    let outcome: GatewayWorkflowRunOutcome;
    if (!workflow) {
      const refusal = (await deps.productionRefusal?.(tool.workflowId)) ?? null;
      outcome = { status: "error", error: refusal ? `Workflow '${tool.workflowName}': ${refusal}` : `Workflow '${tool.workflowName}' no longer exists.` };
    } else {
      const total = workflow.nodes.length;
      let done = 0;
      input.progress(0, total, `Started workflow '${workflow.name}'`);
      ran = true;
      // 12.2 — the run's input carries what the session has collected (not the client's own `user` label: the run's
      // input keeps the provenance a gateway run always has).
      const sessionLabels = callLabels
        ? { provenance: callLabels.provenance.filter((label) => label !== "user"), dataClasses: callLabels.dataClasses }
        : undefined;
      try {
        outcome = await deps.runWorkflowTool({
          workflow,
          nodeId: tool.nodeId,
          toolName: tool.name,
          args,
          executionId,
          subject: auth.subject,
          client: auth.client,
          ...(sessionLabels && (sessionLabels.provenance.length > 0 || sessionLabels.dataClasses.length > 0) ? { sessionLabels } : {}),
          ...(callLabels ? { tracksLabels: true } : {}),
          ...(guardStack && guardStack.refs.length > 0 ? { gatewayGuard: { toolsetId: toolset.id, clientId: auth.client.id, profiles: guardStack.refs } } : {}),
          toolset,
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
    // 12.6 — the run's answer (its output or error text) reaches the client like a server tool's result: it is
    // checked like one. A run that paused or was canceled answers with the gateway's own words.
    let guardResultBlocked: Extract<GatewayGuardOutcome, { action: "block" }> | null = null;
    const guardScope: GuardCallScope = { session, auth, toolset, tool, callExecutionId, ...(ran ? { runExecutionId: executionId } : {}), ...(callLabels ? { callLabels } : {}) };
    if (outcome.status === "success") {
      let output: unknown = outcome.output ?? null;
      if (guardStack) {
        // Guard reads the run's answer only after secret values are scrubbed out of it, as for a server tool's result.
        const scrubbed = scrubOutput(output);
        const verdict = await guardCheck(guardStack, "tool_result", guardScope, scrubbed);
        if (verdict.action === "block") guardResultBlocked = verdict;
        else if (verdict.action === "rewrite") output = verdict.content;
        else output = scrubbed;
      }
      result = guardResultBlocked ? toolError(guardResultBlocked.reason, meta) : toolSuccess(output, meta);
    } else if (outcome.status === "waiting_approval") {
      errorText = `The workflow is waiting for an approval (execution ${executionId}); it did not return a result.`;
      result = toolError(errorText, meta);
    } else if (outcome.status === "canceled") {
      errorText = "The workflow run was canceled.";
      result = toolError(errorText, meta);
    } else {
      errorText = truncate(deps.redact(outcome.error ?? "The workflow run failed."));
      if (guardStack) {
        const verdict = await guardCheck(guardStack, "tool_result", guardScope, errorText);
        if (verdict.action === "block") guardResultBlocked = verdict;
        else if (verdict.action === "rewrite") errorText = truncate(deps.redact(typeof verdict.content === "string" ? verdict.content : JSON.stringify(verdict.content)));
      }
      result = toolError(guardResultBlocked ? guardResultBlocked.reason : errorText, meta);
    }
    // Telemetry describes the run: a blocked answer still counts as the run's own outcome.
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
        clientId: auth.client.id,
        toolsetId: toolset.id,
        ...recordedLabels(callLabels),
        ...callContext(args, tool.inputSchema, auth, toolset)
      });
    } catch (error) {
      app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "Failed to record MCP gateway telemetry");
    }
    // 12.2 — a run's output (or its error text) goes back to the client with the labels the engine gave it; without
    // them (a run on another instance, a run that failed) it counts as outside content. A run that paused or was
    // canceled answers with the gateway's own words only.
    if (ran && outcome.status !== "waiting_approval" && outcome.status !== "canceled") {
      const known = outcome.labels;
      await noteResult(session, auth, toolset, tool.name, {
        provenance: outcome.status === "success" && known ? known.provenance : ["untrusted_external", ...(known?.provenance ?? [])],
        dataClasses: known?.dataClasses ?? []
      });
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
      details: {
        workflowId: tool.workflowId,
        executionId,
        status: outcome.status,
        ...(errorText ? { error: errorText } : {}),
        ...(guardResultBlocked ? { guard: { blocked: true, channel: "tool_result", executionId: callExecutionId } } : {})
      }
    });
    if (guardResultBlocked) await guardBlocked(guardResultBlocked, "tool_result", guardScope);
    return result;
  };

  // ---------------------------------------------------------------------------
  // Phase 12.4 — argument-aware tool policy for server tools
  // ---------------------------------------------------------------------------

  type GatewayPolicyGate =
    /**
     * `approvalId`: the approval this call used, put back when the call is refused before it reaches the server.
     * `callArgs` (12.6): the arguments Guard let through (rewritten, when a profile redacted part of them).
     */
    | { outcome: "call"; policyDecision?: McpToolPolicyDecisionRecord; approvalId?: string; callArgs?: Record<string, unknown> }
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
    requestId: JsonRpcRequest["id"],
    /** 12.2 — the session's labels (tracking toolsets only); undefined: checked without labels, as before. */
    callLabels?: DataLabels,
    /**
     * 12.6 — Guard on the arguments (a toolset or client binding applies): run once the tool policy lets the call
     * through, and for a call held for approval before an approval is asked for or used, so a call Guard blocks
     * never takes up an admin's approval. Approvals still match the client's own arguments.
     */
    guardArgs?: () => Promise<{ blocked: McpCallToolResult } | { args: Record<string, unknown> }>
  ): Promise<GatewayPolicyGate> => {
    const screen = async (): Promise<{ respond: GatewayPolicyGate } | { callArgs?: Record<string, unknown> }> => {
      if (!guardArgs) return {};
      const checked = await guardArgs();
      return "blocked" in checked ? { respond: { outcome: "respond", response: rpcResult(requestId, checked.blocked) } } : { callArgs: checked.args };
    };
    const screened = async (call: Extract<GatewayPolicyGate, { outcome: "call" }>): Promise<GatewayPolicyGate> => {
      const checked = await screen();
      return "respond" in checked ? checked.respond : { ...call, ...(checked.callArgs ? { callArgs: checked.callArgs } : {}) };
    };
    const rules = await store.listMcpToolPolicies();
    if (rules.length === 0) return await screened({ outcome: "call" });
    const labelRecord = callLabels ? recordedCallLabels(callLabels, false) : undefined;
    // Phase 12.2 — open world, only when a rule reads the open-world hint.
    const openWorld = policyReadsOpenWorld(rules) ? await openWorldMarking(store, rules, await store.getMcpServer(tool.serverId)) : undefined;
    const decision = evaluateToolForContext(
      {
        rules,
        classifications: await store.listMcpToolClassifications(tool.serverId),
        role: auth.subject.role,
        projectId: toolset.projectId ?? null,
        adapterId: tool.adapterId,
        registryServerId: tool.serverId,
        serverLabel: tool.serverName,
        clientId: auth.client.id,
        toolsetId: toolset.id,
        ...(openWorld ? { openWorld } : {})
      },
      { name: tool.toolName, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
      "tool",
      { arguments: args, ...(callLabels ? { dataLabels: policyCallLabels(callLabels) } : {}) }
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
      ...scopeMetadata(session)
    };
    if (!decision.allowed) {
      const record = policyDecisionRecord(decision.policy, undefined, labelRecord);
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
    if (!decision.approval) return await screened({ outcome: "call", ...withRecord(policyDecisionRecord(decision.policy, undefined, labelRecord)) });

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

    // 12.6 — Guard first: a call it blocks neither uses an approval nor asks for one.
    const checked = await screen();
    if ("respond" in checked) return checked.respond;
    const callArgs = checked.callArgs ? { callArgs: checked.callArgs } : {};
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
        return { outcome: "call", approvalId: usable.id, ...withRecord(policyDecisionRecord(decision.policy, "approved", labelRecord)), ...callArgs };
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
        expiresAt: new Date(now.getTime() + GATEWAY_APPROVAL_PENDING_MS).toISOString(),
        // 12.2 — the session mark that drove the hold, as the approval_requested audit event records it.
        labels: labelRecord ?? null
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
        metadata: {
          ...callMetadata,
          approvalRequestId: approval.id,
          argsHash,
          ruleId: decision.approval.ruleId,
          ruleName: decision.approval.ruleName ?? null,
          // 12.2 — what the session had collected when the call was held (tracking toolsets only).
          ...(labelRecord ? { labels: labelRecord } : {})
        }
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
  /** 12.2 — the labels a call was checked with, for its telemetry row (names only; never a class list: nothing scans). */
  const recordedLabels = (callLabels: DataLabels | undefined) => {
    const labels = callLabels ? recordedCallLabels(callLabels, false) : undefined;
    return labels ? { labels } : {};
  };

  // ---------------------------------------------------------------------------
  // Request dispatch
  // ---------------------------------------------------------------------------

  /** 12.6 — the JSON-RPC error for a call a used-up `block` budget refused. */
  const budgetRefusal = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    request: JsonRpcRequest,
    toolName: string,
    blocked: BudgetExceededError
  ): Promise<JsonRpcResponse> => {
    await auditLimitRefusal(session, auth, toolset, "mcp_gateway.budget_blocked", {
      tool: toolName,
      budgetId: blocked.budget.id,
      scopeType: blocked.budget.scopeType,
      current: blocked.current,
      limit: blocked.limit
    });
    return rpcError(request.id, JSON_RPC_ERRORS.budgetExceeded, blocked.message, {
      budgetId: blocked.budget.id,
      period: blocked.budget.period,
      periodStart: blocked.periodStart,
      retryAfterSeconds: retryAfterSeconds(blocked.budget.period)
    });
  };

  /**
   * 12.6 — every `tools/call` (each call of a batch too) first passes the client's rate limit, when it or its toolset
   * has one; the concurrency slot is held until the call ends. No limit: nothing is counted and nothing is read.
   */
  const handleToolsCall = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    request: JsonRpcRequest,
    emit: Emit,
    modern?: ModernCallScope
  ): Promise<JsonRpcResponse | typeof SUPPRESSED> => {
    const effective = effectiveGatewayRateLimit(auth.client, toolset);
    if (!effective) return await handleLimitedToolsCall(session, auth, toolset, request, emit, modern);
    const admitted = await limiter.acquire(effective.key, effective.limit);
    if (!admitted.ok) {
      await auditLimitRefusal(session, auth, toolset, "mcp_gateway.rate_limited", {
        reason: admitted.reason,
        limitSource: effective.source,
        limit: effective.limit,
        tool: typeof asRecord(request.params).name === "string" ? asRecord(request.params).name : null
      });
      return rpcError(request.id, JSON_RPC_ERRORS.retryLater, admitted.message, {
        reason: admitted.reason,
        retryAfterMs: admitted.retryAfterMs,
        retryAfterSeconds: Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))
      });
    }
    try {
      return await handleLimitedToolsCall(session, auth, toolset, request, emit, modern);
    } finally {
      admitted.release();
    }
  };

  const handleLimitedToolsCall = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    request: JsonRpcRequest,
    emit: Emit,
    modern?: ModernCallScope
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
          ...scopeMetadata(session),
          ...(hidden.ruleId ? { ruleId: hidden.ruleId } : {})
        }
      });
      return rpcResult(request.id, toolError(hidden.message));
    }

    // 12.6 — a used-up `block` budget of the client, the toolset's project or the deployment (and, for a workflow tool,
    // the workflow's) refuses the call before the tool policy. Without a matching block budget nothing is read.
    if (deps.budgets) {
      let blocked: BudgetExceededError | null;
      try {
        blocked = await deps.budgets.checkBlock(budgetContext(auth, toolset, tool.kind === "workflow" ? { workflowId: tool.workflowId, projectId: tool.projectId } : null));
      } catch (error) {
        app.log.warn(
          { err: deps.redact(error instanceof Error ? error.message : String(error)), toolsetId: toolset.id, clientId: auth.client.id, tool: tool.name },
          "MCP gateway could not check the budgets of a call; the call was refused"
        );
        return rpcResult(request.id, toolError("Budgets could not be checked for this call, so it was not sent. Try again."));
      }
      if (blocked) return await budgetRefusal(session, auth, toolset, request, tool.name, blocked);
    }

    // 12.2 — read from the session only, never from the request (`_meta`, headers or arguments).
    const callLabels = await labelsForCall(session, auth, toolset);
    // 12.6 — the toolset's and client's Guard profiles. A failed read refuses the call: it may have a binding.
    let guardStack: GatewayGuardStackForCall | undefined;
    try {
      guardStack = await guardStackFor(auth, toolset);
    } catch (error) {
      app.log.warn(
        { err: deps.redact(error instanceof Error ? error.message : String(error)), toolsetId: toolset.id, clientId: auth.client.id, tool: tool.name },
        "MCP gateway could not read the Guard bindings for a call; the call was refused"
      );
      return rpcResult(request.id, toolError("Content rules could not be checked for this call, so it was not sent. Try again."));
    }
    // A workflow tool's run id, and the call's synthetic id: a server tool call's telemetry row and the gateway's Guard
    // events share the synthetic one (kept apart from a workflow tool's run, whose replays compare its own events).
    const executionId = crypto.randomUUID();
    const callExecutionId = `mcpgw_${crypto.randomUUID()}`;
    const guardArgs = guardStack
      ? async () => {
          try {
            return await guardArguments(guardStack, { session, auth, toolset, tool, callExecutionId, ...(callLabels ? { callLabels } : {}) }, args);
          } catch (error) {
            // Still fails closed, but as the tool error a client can read, not a protocol error.
            app.log.warn(
              { err: deps.redact(error instanceof Error ? error.message : String(error)), toolsetId: toolset.id, clientId: auth.client.id, tool: tool.name },
              "MCP gateway Guard could not check the arguments of a call; the call was refused"
            );
            return { blocked: toolError("Content rules could not check this call, so it was not sent.") };
          }
        }
      : undefined;
    let callArgs = args;
    let policyDecision: McpToolPolicyDecisionRecord | undefined;
    let usedApprovalId: string | undefined;
    if (tool.kind === "server") {
      const gate = await gatewayPolicyGate(session, auth, toolset, tool, args, request.id, callLabels, guardArgs);
      if (gate.outcome === "respond") return gate.response;
      policyDecision = gate.policyDecision;
      usedApprovalId = gate.approvalId;
      if (gate.callArgs) callArgs = gate.callArgs;
    } else if (guardArgs) {
      const checked = await guardArgs();
      if ("blocked" in checked) return rpcResult(request.id, checked.blocked);
      callArgs = checked.args;
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

    // MCP 2026-07-28 — the caller closed the connection before the call started: nothing is sent, and an approval the
    // call used is given back (as for a call refused before it reached the server).
    if (modern?.disconnect.aborted) {
      if (usedApprovalId) await store.restoreMcpGatewayApproval(usedApprovalId);
      return SUPPRESSED;
    }
    const key = modern ? modern.inFlightKey : requestKey(request.id);
    const controller = new AbortController();
    const entry: GatewayInFlight = {
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
    };
    session.inFlight.set(key, entry);
    // MCP 2026-07-28 — on HTTP, closing the response stream is the cancellation: same effect as notifications/cancelled.
    const onDisconnect = () => void cancelInFlight(entry, "The client closed the connection.");
    modern?.disconnect.addEventListener("abort", onDisconnect, { once: true });
    try {
      const result =
        tool.kind === "workflow"
          ? await callWorkflowTool({ session, auth, toolset, tool, args: callArgs, executionId, callExecutionId, progress, ...(callLabels ? { callLabels } : {}), ...(guardStack ? { guardStack } : {}) })
          : await callServerTool({
              session,
              auth,
              toolset,
              tool,
              args: callArgs,
              callExecutionId,
              signal: controller.signal,
              progress,
              ...(callLabels ? { callLabels } : {}),
              ...(guardStack ? { guardStack } : {}),
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
      modern?.disconnect.removeEventListener("abort", onDisconnect);
      session.inFlight.delete(key);
      sessions.touch(session);
    }
  };

  const dispatch = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    request: JsonRpcRequest,
    emit: Emit,
    modern?: ModernCallScope
  ): Promise<JsonRpcResponse | typeof SUPPRESSED> => {
    try {
      if (modern) return await dispatchModern(session, auth, toolset, request, emit, modern);
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

  /**
   * MCP 2026-07-28 — a modern request's method (validation already passed; `server/discover` is answered before any
   * state is looked up): `tools/list` (sorted by name, with cache hints and no `x-mcp-header` annotations) and
   * `tools/call`. Results and errors are made modern by
   * the caller (`modernizeGatewayResponse`).
   */
  const dispatchModern = async (
    session: GatewaySession,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    request: JsonRpcRequest,
    emit: Emit,
    modern: ModernCallScope
  ): Promise<JsonRpcResponse | typeof SUPPRESSED> => {
    switch (request.method) {
      case "tools/list": {
        const params = asRecord(request.params);
        const offset = params.cursor === undefined ? 0 : decodeCursor(params.cursor);
        if (offset === null) return rpcError(request.id, JSON_RPC_ERRORS.invalidParams, "Invalid cursor.");
        const catalog = await catalogFor(toolset, auth.subject.role, auth.client.id);
        const ordered = sortToolsByName(catalog.tools);
        const page = ordered.slice(offset, offset + TOOLS_PAGE_SIZE);
        const next = offset + TOOLS_PAGE_SIZE < ordered.length ? encodeCursor(offset + TOOLS_PAGE_SIZE) : undefined;
        const tools: Record<string, unknown>[] = [];
        for (const tool of page) {
          const descriptor = stripDescriptorHeaderAnnotations(toMcpToolDescriptor(tool));
          if (descriptor) tools.push(descriptor);
          else app.log.warn({ toolsetId: toolset.id, tool: tool.name }, "MCP gateway left a tool out of a modern tools/list: its input schema is too deep");
        }
        return rpcResult(request.id, { tools, ...(next ? { nextCursor: next } : {}), ttlMs: listTtlMs, cacheScope: "private" });
      }
      case "tools/call":
        return await handleToolsCall(session, auth, toolset, request, emit, modern);
      default:
        return rpcError(request.id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${request.method}`);
    }
  };

  /** Abort an in-flight call and run its cleanup (cancel the run, stop the servers); a second cancel does nothing. */
  const cancelInFlight = async (entry: GatewayInFlight, reason: string) => {
    if (entry.controller.signal.aborted) return;
    entry.controller.abort(reason);
    try {
      await entry.onCancel?.(reason);
    } catch (error) {
      app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "MCP gateway cancellation cleanup failed");
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
      await cancelInFlight(entry, reason);
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

  /** Headers set by hooks (CORS, security headers): they are not flushed for a hijacked reply. */
  const hookHeadersOf = (reply: FastifyReply): Record<string, string | number | string[]> => {
    const headers: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };

  /** The legacy answer to a request without a session: dual-era clients read it as "legacy server" and fall back. */
  const SESSION_REQUIRED_MESSAGE = "Mcp-Session-Id header is required; send initialize first.";

  /**
   * MCP 2026-07-28 — one modern request (MCP_GATEWAY_MODERN_PROTOCOL=on): validated, then served statelessly. No
   * session is opened, read or echoed (an `Mcp-Session-Id` header is ignored); `tools/list` and `tools/call` run with
   * the caller's principal state. Closing the connection cancels the call.
   */
  const handleModernPost = async (
    request: FastifyRequest,
    reply: FastifyReply,
    auth: AuthenticatedClient,
    toolset: McpToolset,
    parsed: unknown,
    accept: string | undefined
  ) => {
    const serverInfo = gatewayServerInfo(toolset, SERVER_VERSION);
    const validated = validateModernGatewayMessage(parsed, headerLookupFrom(request.headers), modernMode);
    if (!validated.ok) {
      reply.code(validated.status).header("content-type", "application/json").send(modernizeGatewayResponse(validated.response, serverInfo));
      return;
    }
    if (validated.kind === "notification") {
      // No client notification is defined over HTTP for modern versions (cancel = close the connection): ignored.
      reply.code(202).send();
      return;
    }
    const message = validated.message;
    if (!MODERN_GATEWAY_METHODS.has(message.method)) {
      reply
        .code(404)
        .header("content-type", "application/json")
        .send(rpcError(message.id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${message.method.slice(0, 100)}`));
      return;
    }
    if (message.method === "server/discover") {
      reply
        .code(200)
        .header("content-type", "application/json")
        .send(modernizeGatewayResponse(rpcResult(message.id, gatewayDiscoverResult({ toolset, mode: modernMode, ttlMs: listTtlMs })), serverInfo));
      return;
    }
    // The caller's principal state.
    let state: GatewaySession;
    {
      const principalScope = gatewayPrincipalScope({ clientId: auth.client.id, toolsetId: toolset.id, userId: auth.subject.userId ?? null });
      try {
        const found = await sessions.principal({
          principalScope,
          clientId: auth.client.id,
          toolsetId: toolset.id,
          protocolVersion: validated.protocolVersion,
          clientInfo: validated.clientInfo
        });
        state = found.state;
        if (found.created) {
          // First modern request of this caller in an idle window (the counterpart of session_started).
          await deps.auditRaw({
            category: "system",
            eventType: "mcp_gateway.caller_seen",
            action: "create",
            outcome: "success",
            actor: { type: "api_key", email: auth.client.name, ipAddress: request.ip ?? null },
            resourceType: "mcp_toolset",
            resourceId: toolset.id,
            projectId: toolset.projectId,
            metadata: {
              principalScope,
              clientId: auth.client.id,
              role: auth.subject.role,
              protocolVersion: validated.protocolVersion,
              clientInfo: found.state.clientInfo
            }
          });
        }
      } catch (error) {
        if (error instanceof GatewaySessionLimitError) {
          reply
            .code(503)
            .header("retry-after", "30")
            .header("content-type", "application/json")
            .send(
              modernizeGatewayResponse(
                rpcError(message.id, JSON_RPC_ERRORS.retryLater, error.message, { reason: "gateway_capacity", retryAfterMs: 30_000, retryAfterSeconds: 30 }),
                serverInfo
              )
            );
          return;
        }
        throw error;
      }
    }

    // Closing the connection before the response is complete cancels the request (not a finished response).
    const disconnect = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) disconnect.abort();
    };
    reply.raw.on("close", onClose);
    // Gone already (while its state was looked up): the call is cancelled before it starts.
    if (reply.raw.destroyed && !reply.raw.writableFinished) disconnect.abort();
    const scope: ModernCallScope = { inFlightKey: `modern:${crypto.randomUUID()}`, disconnect: disconnect.signal };
    const run = async (emit: Emit) => await dispatch(state, auth, toolset, message, emit, scope);

    const meta = asRecord(asRecord(message.params)._meta);
    const wantsStream = acceptAllows(accept, "text/event-stream") && (typeof meta.progressToken === "string" || typeof meta.progressToken === "number");
    if (wantsStream) {
      const hookHeaders = hookHeadersOf(reply);
      reply.hijack();
      reply.raw.writeHead(200, {
        ...hookHeaders,
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Reverse proxies must not buffer the stream (progress would arrive late).
        "x-accel-buffering": "no",
        "x-request-id": request.id
      });
      const stopHeartbeat = startSseHeartbeat(reply.raw, config.SSE_HEARTBEAT_INTERVAL_MS);
      try {
        const response = await run((notification) => {
          if (!disconnect.signal.aborted) writeSse(reply, notification);
        });
        if (response !== SUPPRESSED && !disconnect.signal.aborted) writeSse(reply, modernizeGatewayResponse(response, serverInfo));
      } finally {
        stopHeartbeat();
        reply.raw.off("close", onClose);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
      return;
    }
    let response: JsonRpcResponse | typeof SUPPRESSED;
    try {
      response = await run(() => undefined);
    } finally {
      reply.raw.off("close", onClose);
    }
    reply
      .code(200)
      .header("content-type", "application/json")
      .send(
        modernizeGatewayResponse(response === SUPPRESSED ? rpcError(message.id, JSON_RPC_ERRORS.requestCancelled, "Request cancelled.") : response, serverInfo)
      );
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
      // MCP 2026-07-28 — a modern request (a single message with the protocol version in its _meta) is served
      // statelessly when modern mode is on. Anything else, and everything when it is off, takes the session path below
      // exactly as before (a modern request then gets the "session required" answer, so dual-era clients fall back).
      if (modernMode === "on") {
        let early: unknown;
        let earlyParsed = false;
        try {
          early = JSON.parse(typeof request.body === "string" ? request.body : "");
          earlyParsed = true;
        } catch {
          // Not JSON: the session path answers with its parse error.
        }
        if (earlyParsed && isModernGatewayMessage(early)) {
          if (deps.clusterMode && toolset.trackSessionLabels) {
            // Until the label mark is shared across instances, a toolset that tracks outside content per session serves
            // only session-based callers in cluster mode. This answer is not a modern error, so a client that speaks
            // both versions falls back to initialize and a session.
            httpError(
              reply,
              400,
              `${SESSION_REQUIRED_MESSAGE} Toolset '${toolset.slug}' tracks outside content per session, so in cluster mode it serves only session-based clients.`
            );
            return reply;
          }
          await handleModernPost(request, reply, auth, toolset, early, accept);
          return reply;
        }
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
        httpError(reply, 400, SESSION_REQUIRED_MESSAGE);
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
        const hookHeaders = hookHeadersOf(reply);
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
      activeSessions: sessions.count((session) => session.era === "legacy" && session.toolsetId === toolset.id)
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

  /** 12.2 — "Track outside content per session" turned on or off. */
  const auditSessionTracking = async (request: FastifyRequest, user: SafeUser, toolset: McpToolset) => {
    await deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_toolset.session_tracking_changed",
      action: "update",
      outcome: "success",
      resourceType: "mcp_toolset",
      resourceId: toolset.id,
      projectId: toolset.projectId,
      metadata: {
        slug: toolset.slug,
        trackSessionLabels: toolset.trackSessionLabels,
        openSessions: sessions.count((session) => session.era === "legacy" && session.toolsetId === toolset.id)
      }
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
    const pageRequest = pageRequestFromQuery(request.query);
    if (pageRequest) {
      const page = pageOfById(await store.listMcpToolsets(), pageRequest, (toolset) => `${toolset.name.toLowerCase()}\u0000${toolset.slug}`);
      return { ...page, items: await mapAsync(page.items, toolsetView), gatewayBaseUrl, protocolVersions: gatewaySupportedVersions(modernMode) };
    }
    return {
      toolsets: await mapAsync(await store.listMcpToolsets(), toolsetView),
      gatewayBaseUrl,
      protocolVersions: gatewaySupportedVersions(modernMode)
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
      trackSessionLabels: parsed.data.trackSessionLabels ?? false,
      rateLimit: normalizeGatewayRateLimit(parsed.data.rateLimit),
      createdBy: user.email,
      members
    });
    await auditToolset(request, user, "mcp_toolset.created", "create", toolset);
    if (toolset.trackSessionLabels) await auditSessionTracking(request, user, toolset);
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
    const { members: _members, rateLimit, ...fields } = parsed.data;
    const updated = (await store.updateMcpToolset(existing.id, {
      ...fields,
      ...(rateLimit !== undefined ? { rateLimit: normalizeGatewayRateLimit(rateLimit) } : {}),
      ...(members ? { members } : {})
    }))!;
    // A new URL or a disabled toolset ends the sessions bound to the old one.
    if (updated.slug !== existing.slug || !updated.enabled) {
      await sessions.endWhere((session) => session.toolsetId === existing.id, "toolset_removed");
    }
    await auditToolset(request, user, "mcp_toolset.updated", "update", updated, {
      fields: Object.keys(parsed.data),
      // 12.6 — the default rate limit for its clients, when this update changed it.
      ...(rateLimit !== undefined ? { rateLimit: updated.rateLimit, previousRateLimit: existing.rateLimit } : {})
    });
    if (updated.trackSessionLabels !== existing.trackSessionLabels) await auditSessionTracking(request, user, updated);
    return { toolset: await toolsetView(updated) };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/toolsets/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const existing = await findToolset(request.params.id, reply);
    if (!existing) return reply;
    await store.deleteMcpToolset(existing.id);
    await sessions.endWhere((session) => session.toolsetId === existing.id, "toolset_removed");
    // 12.6 — its Guard binding goes with it (resolution ignores a deleted toolset's binding anyway).
    const clearedGuard = await deps.guard?.clearGatewayBinding("toolset", existing.id, user.id);
    await auditToolset(request, user, "mcp_toolset.deleted", "delete", existing, clearedGuard ? { guardBindingRemoved: clearedGuard } : {});
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
    activeSessions: sessions.count((session) => session.era === "legacy" && session.clientId === client.id),
    usage: usage ? { calls: usage.calls, errors: usage.errors, lastCalledAt: usage.lastCalledAt } : { calls: 0, errors: 0, lastCalledAt: null }
  });

  app.get("/api/mcp/clients", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const since = new Date(Date.now() - MCP_TELEMETRY_WINDOWS["7d"]).toISOString();
    const usage = new Map((await store.summarizeMcpClientUsage(since)).map((row) => [row.clientId, row]));
    const pageRequest = pageRequestFromQuery(request.query);
    if (pageRequest) {
      const page = pageOfById(await store.listMcpClients(), pageRequest, (client) => client.createdAt);
      return { ...page, items: await mapAsync(page.items, (client) => clientView(client, usage.get(client.id))), usageWindow: "7d" };
    }
    return {
      usageWindow: "7d",
      clients: await mapAsync(await store.listMcpClients(), (client) => clientView(client, usage.get(client.id)))
    };
  });

  app.post("/api/mcp/clients", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    if (deps.requireStepUp && !(await deps.requireStepUp(request, reply, "mcp_client.create"))) return reply;
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
    // 12.6 — a revoked client keeps no Guard binding.
    const clearedGuard = await deps.guard?.clearGatewayBinding("mcp_client", existing.id, user.id);
    if (!existing.revokedAt) {
      await deps.auditUser(request, user, {
        category: "system",
        eventType: "mcp_client.revoked",
        action: "update",
        outcome: "success",
        resourceType: "mcp_client",
        resourceId: existing.id,
        metadata: { name: existing.name, tokenPrefix: existing.tokenPrefix, closedSessions: closed, ...(clearedGuard ? { guardBindingRemoved: clearedGuard } : {}) }
      });
    }
    return { client: await clientView(revoked) };
  });

  // 13.2 — an admin rotates a client's token: a new token (shown once), and the old one keeps working for the grace
  // window (graceHours, 24 by default, 0 ends it now). The client's name, role, toolsets, limits, network settings and
  // live sessions stay as they are; a session keeps working while it presents either token. While an old token is in
  // its window, only a rotation with graceHours 0 (which ends every old token) is taken.
  app.post<{ Params: { id: string } }>("/api/mcp/clients/:id/rotate", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    if (deps.requireStepUp && !(await deps.requireStepUp(request, reply, "mcp_client.rotate"))) return reply;
    const parsed = credentialRotateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid rotation payload", details: parsed.error.issues };
    }
    const existing = await store.getMcpClient(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Client not found" };
    }
    const graceHours = parsed.data.graceHours ?? KEY_ROTATION_GRACE_HOURS.default;
    const rotated = await clientService.rotate({ client: existing, graceHours });
    if (!rotated.ok) {
      if (rotated.reason === "not_found") {
        reply.code(404);
        return { error: "Client not found" };
      }
      reply.code(409);
      if (rotated.reason === "pending") {
        return {
          error: `The previous token still works until ${existing.previousExpiresAt}. Wait for it to end, or rotate with graceHours 0 to end every old token now.`,
          code: "rotation_pending"
        };
      }
      return rotated.reason === "inactive"
        ? { error: "A revoked or expired client cannot be rotated; create a new one", code: "inactive" }
        : { error: "The client's token was rotated at the same time by another request; reload and try again", code: "rotation_conflict" };
    }
    await deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_client.rotated",
      action: "update",
      outcome: "success",
      resourceType: "mcp_client",
      resourceId: existing.id,
      metadata: {
        name: existing.name,
        previousTokenPrefix: existing.tokenPrefix,
        tokenPrefix: rotated.client.tokenPrefix,
        graceHours,
        previousExpiresAt: rotated.client.previousExpiresAt ?? null,
        ...(existing.previousTokenPrefix && existing.previousExpiresAt && Date.parse(existing.previousExpiresAt) > Date.now()
          ? { endedEarlierTokenPrefix: existing.previousTokenPrefix }
          : {})
      }
    });
    // The only response that carries the new token.
    return { client: await clientView(rotated.client), token: rotated.token };
  });

  // 12.6 — an admin renames a client or sets its rate limit (null removes it). Nothing else about it changes.
  app.patch<{ Params: { id: string } }>("/api/mcp/clients/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const existing = await store.getMcpClient(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Client not found" };
    }
    const parsed = mcpClientUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid client payload", details: parsed.error.issues };
    }
    const patch = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.rateLimit !== undefined ? { rateLimit: normalizeGatewayRateLimit(parsed.data.rateLimit) } : {})
    };
    const updated = await store.updateMcpClient(existing.id, patch);
    if (!updated) {
      reply.code(404);
      return { error: "Client not found" };
    }
    await deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_client.updated",
      action: "update",
      outcome: "success",
      resourceType: "mcp_client",
      resourceId: existing.id,
      metadata: {
        fields: Object.keys(patch),
        name: updated.name,
        ...(patch.name !== undefined && patch.name !== existing.name ? { previousName: existing.name } : {}),
        ...(patch.rateLimit !== undefined ? { rateLimit: updated.rateLimit, previousRateLimit: existing.rateLimit } : {})
      }
    });
    return { client: await clientView(updated) };
  });

  // 12.6 — every budget that applies to a client (its own, its toolsets' projects', the deployment's), with what each
  // counted this period and whether it refuses the client's calls now (the client's Governance section).
  app.get<{ Params: { id: string } }>("/api/mcp/clients/:id/budgets", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const client = await store.getMcpClient(request.params.id);
    if (!client) {
      reply.code(404);
      return { error: "Client not found" };
    }
    if (!deps.budgets) return { clientId: client.id, budgets: [] };
    // Admins see every amount; a builder sees only projects they can read, and the deployment's budget without amounts
    // (the budget routes and usage pages are admin-only).
    const viewer = user.role === "admin" ? undefined : { canReadProject: async (projectId: string) => (await deps.runAccess.project(user, projectId, "workflow:read")).ok };
    return { clientId: client.id, budgets: await deps.budgets.clientUsage({ id: client.id, name: client.name, toolsetIds: client.toolsetIds }, viewer) };
  });

  // 13.2 — a client's address list and certificate pin. A dedicated route (admin), audited with before and after.
  app.put<{ Params: { id: string } }>("/api/mcp/clients/:id/network", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const parsed = mcpClientNetworkUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? "Invalid network settings", details: parsed.error.issues };
    }
    const existing = await store.getMcpClient(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Client not found" };
    }
    if (existing.revokedAt) {
      reply.code(409);
      return { error: "This client is revoked" };
    }
    const next = {
      allowedIps: parsed.data.allowedIps ?? existing.allowedIps,
      certFingerprints: parsed.data.certFingerprints ?? existing.certFingerprints,
      certSubject: parsed.data.certSubject !== undefined ? parsed.data.certSubject : existing.certSubject
    };
    if (next.allowedIps.length > 0 && parseTrustProxy(config.TRUST_PROXY) === true) {
      reply.code(400);
      return {
        error:
          "Address lists cannot be used with TRUST_PROXY=true: any client could choose the address it is checked by. Set TRUST_PROXY to your proxy's address or hop count first."
      };
    }
    if (next.certFingerprints.length > 0 && !deps.network?.settings.clientCertHeader) {
      reply.code(400);
      return {
        error:
          "Client certificates are off on this deployment: set MCP_GATEWAY_CLIENT_CERT_HEADER (and the proxies it is honoured from) before pinning a certificate, or the client could not connect."
      };
    }
    if (next.certSubject && next.certFingerprints.length === 0) {
      reply.code(400);
      return { error: "A subject pin needs at least one certificate fingerprint" };
    }
    const updated = await store.updateMcpClientNetwork(existing.id, next);
    if (!updated) {
      reply.code(404);
      return { error: "Client not found" };
    }
    await deps.auditUser(request, user, {
      category: "system",
      eventType: "mcp_client.network_updated",
      action: "update",
      outcome: "success",
      resourceType: "mcp_client",
      resourceId: existing.id,
      metadata: {
        name: existing.name,
        before: { allowedIps: existing.allowedIps, certFingerprints: existing.certFingerprints, certSubject: existing.certSubject },
        after: { allowedIps: updated.allowedIps, certFingerprints: updated.certFingerprints, certSubject: updated.certSubject }
      }
    });
    return { client: await clientView(updated) };
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

  // 12.2 — a client's open sessions on this instance, with the labels each has collected on a tracking toolset.
  app.get<{ Params: { id: string } }>("/api/mcp/clients/:id/sessions", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const client = await store.getMcpClient(request.params.id);
    if (!client) {
      reply.code(404);
      return { error: "Client not found" };
    }
    const open = sessions.list((session) => session.era === "legacy" && session.clientId === client.id);
    const toolsets = new Map<string, McpToolset | null>();
    for (const toolsetId of new Set(open.map((session) => session.toolsetId))) toolsets.set(toolsetId, await store.getMcpToolset(toolsetId));
    const views: McpGatewaySessionView[] = open.map((session) => {
      const toolset = toolsets.get(session.toolsetId) ?? null;
      const tracked = toolset?.trackSessionLabels === true;
      return {
        idPrefix: session.id.slice(0, 8),
        clientId: session.clientId,
        toolsetId: session.toolsetId,
        toolsetName: toolset?.name ?? null,
        clientInfo: session.clientInfo,
        createdAt: new Date(session.createdAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
        tracked,
        labels: tracked ? sessionLabelsView(session.labels) : null,
        raisedAt: tracked && session.labels.raisedAt !== null ? new Date(session.labels.raisedAt).toISOString() : null,
        guard: {
          blocks: session.guard.blocks,
          lastBlock: session.guard.lastBlock ? { ...session.guard.lastBlock, at: new Date(session.guard.lastBlock.at).toISOString() } : null
        }
      };
    });
    return { clientId: client.id, sessions: views };
  });

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
