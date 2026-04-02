import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyRawBody from "fastify-raw-body";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  agentWebhookPayloadSchema,
  nodeDefinitions,
  workflowExecuteRequestSchema,
  workflowSchema,
  type MCPServerConfig,
  type SecretReference,
  type Workflow,
  type WorkflowExecutionState
} from "@ai-orchestrator/shared";
import {
  executeCodeNodeSandbox,
  executeWorkflow,
  exportWorkflowToJson,
  importWorkflowFromJson,
  validateWorkflowGraph
} from "@ai-orchestrator/workflow-engine";
import { SqliteStore } from "./db/database";
import type { AppConfig } from "./config";
import { SecretService } from "./services/secret-service";
import { AuthService, type SafeUser, type UserRole } from "./services/auth-service";

const secretCreateSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  value: z.string().min(1)
});

const userRoleSchema = z.enum(["admin", "builder", "operator", "viewer"]);

const authRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: userRoleSchema.optional(),
  admin: z.boolean().optional()
});

const authLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const workflowImportSchema = z.object({
  json: z.string().optional(),
  workflow: z.unknown().optional()
});

const mcpDiscoverSchema = z.object({
  serverId: z.string().min(1),
  label: z.string().optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
  secretRef: z
    .object({
      secretId: z.string().min(1)
    })
    .optional(),
  allowedTools: z.array(z.string()).optional()
});

const approvalDecisionSchema = z.object({
  reason: z.string().optional()
});

const codeNodeTestSchema = z.object({
  code: z.string().min(1),
  timeout: z.number().int().positive().max(60_000).optional(),
  input: z.record(z.string(), z.unknown()).optional()
});

type WebhookAuthMode = "none" | "bearer_token" | "hmac_sha256";

interface NormalizedWebhookSecurityConfig {
  authMode: WebhookAuthMode;
  authHeaderName: string;
  signatureHeaderName: string;
  timestampHeaderName: string;
  secretRef?: SecretReference;
  idempotencyEnabled: boolean;
  idempotencyHeaderName: string;
  replayToleranceSeconds: number;
}

interface WebhookEndpoint {
  nodeId: string;
  path: string;
  method: string;
  config: Record<string, unknown>;
}

const DEFAULT_WEBHOOK_AUTH_HEADER = "authorization";
const DEFAULT_WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";
const DEFAULT_WEBHOOK_TIMESTAMP_HEADER = "x-webhook-timestamp";
const DEFAULT_IDEMPOTENCY_HEADER = "idempotency-key";
const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function normalizeHeaderName(value: unknown, fallback: string): string {
  const input = typeof value === "string" ? value.trim() : "";
  return (input || fallback).toLowerCase();
}

function normalizeWebhookAuthMode(value: unknown): WebhookAuthMode {
  if (value === "bearer_token" || value === "hmac_sha256" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeWebhookSecurityConfig(config: Record<string, unknown>): NormalizedWebhookSecurityConfig {
  const authMode = normalizeWebhookAuthMode(config.authMode);
  const secretRefCandidate = asRecord(config.secretRef);
  const secretRef =
    typeof secretRefCandidate.secretId === "string" && secretRefCandidate.secretId.trim()
      ? ({ secretId: secretRefCandidate.secretId.trim() } satisfies SecretReference)
      : undefined;

  const replayToleranceInput = Number(config.replayToleranceSeconds);
  const replayToleranceSeconds =
    Number.isFinite(replayToleranceInput) && replayToleranceInput > 0
      ? Math.floor(replayToleranceInput)
      : DEFAULT_REPLAY_TOLERANCE_SECONDS;

  return {
    authMode,
    authHeaderName: normalizeHeaderName(config.authHeaderName, DEFAULT_WEBHOOK_AUTH_HEADER),
    signatureHeaderName: normalizeHeaderName(config.signatureHeaderName, DEFAULT_WEBHOOK_SIGNATURE_HEADER),
    timestampHeaderName: normalizeHeaderName(config.timestampHeaderName, DEFAULT_WEBHOOK_TIMESTAMP_HEADER),
    secretRef,
    idempotencyEnabled: config.idempotencyEnabled === true,
    idempotencyHeaderName: normalizeHeaderName(config.idempotencyHeaderName, DEFAULT_IDEMPOTENCY_HEADER),
    replayToleranceSeconds
  };
}

function getHeaderValue(headers: Record<string, unknown>, headerName: string): string {
  const direct = headers[headerName];
  if (typeof direct === "string") {
    return direct.trim();
  }
  if (Array.isArray(direct)) {
    const first = direct[0];
    return typeof first === "string" ? first.trim() : "";
  }
  return "";
}

function normalizeTimestampToMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function stripSignaturePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex > 0) {
    return trimmed.slice(equalsIndex + 1).trim();
  }
  return trimmed;
}

function safeEqualSecret(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function computeSha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function redactSensitiveInput(value: unknown): unknown {
  const sensitiveKeyPattern = /(api[-_]?key|token|password|secret|authorization)/i;

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveInput(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === "secretId") {
      redacted[key] = nestedValue;
      continue;
    }
    if (sensitiveKeyPattern.test(key)) {
      redacted[key] = typeof nestedValue === "string" && nestedValue.length > 0 ? "***redacted***" : nestedValue;
      continue;
    }
    redacted[key] = redactSensitiveInput(nestedValue);
  }

  return redacted;
}

function toDurationMs(startedAt: string, completedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return undefined;
  }
  return Math.max(0, Math.floor(completed - started));
}

function normalizeSessionId(sessionId?: string, sessionIdSnakeCase?: string): string | undefined {
  const camel = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
  const snake = typeof sessionIdSnakeCase === "string" && sessionIdSnakeCase.trim() ? sessionIdSnakeCase.trim() : undefined;
  return camel ?? snake;
}

function resolveWidgetBundlePath(): string {
  const appFilePath = fileURLToPath(import.meta.url);
  const appDirectory = path.dirname(appFilePath);
  return path.resolve(appDirectory, "../../web/dist-widget/widget.js");
}

async function selectWebhookWorkflow(store: SqliteStore, workflowId?: string): Promise<Workflow | null> {
  if (workflowId) {
    return store.getWorkflow(workflowId);
  }

  const workflows = store.listWorkflows();
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow) {
      continue;
    }

    if (workflow.nodes.some((node) => node.type === "webhook_input")) {
      return workflow;
    }
  }

  return workflows.length ? store.getWorkflow(workflows[0].id) : null;
}

const allowedWebhookMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeWebhookPath(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const withFallback = raw || fallback;
  return withFallback.replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeWebhookMethod(value: unknown): string {
  const method = typeof value === "string" ? value.trim().toUpperCase() : "POST";
  return allowedWebhookMethods.has(method) ? method : "POST";
}

function listWebhookEndpoints(workflow: Workflow): WebhookEndpoint[] {
  return workflow.nodes
    .filter((node) => node.type === "webhook_input")
    .map((node) => {
      const config = asRecord(node.config);
      const path = normalizeWebhookPath(config.path, node.id);
      const method = normalizeWebhookMethod(config.method);
      return {
        nodeId: node.id,
        path,
        method,
        config
      };
    });
}

async function selectWebhookByPath(
  store: SqliteStore,
  path: string,
  method: string
): Promise<{ workflow: Workflow; endpoint: WebhookEndpoint } | null> {
  const normalizedPath = normalizeWebhookPath(path, "").toLowerCase();
  const normalizedMethod = normalizeWebhookMethod(method);

  const workflows = store.listWorkflows();
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow) {
      continue;
    }

    const endpoints = listWebhookEndpoints(workflow);
    const endpoint = endpoints.find(
      (entry) => entry.path.toLowerCase() === normalizedPath && entry.method === normalizedMethod
    );
    if (endpoint) {
      return { workflow, endpoint };
    }
  }

  return null;
}

function getRawRequestBody(request: { rawBody?: unknown; body: unknown }): string {
  if (typeof request.rawBody === "string") {
    return request.rawBody;
  }
  if (Buffer.isBuffer(request.rawBody)) {
    return request.rawBody.toString("utf8");
  }

  if (typeof request.body === "string") {
    return request.body;
  }

  if (request.body === undefined || request.body === null) {
    return "";
  }

  try {
    return JSON.stringify(request.body);
  } catch {
    return String(request.body);
  }
}

async function verifyWebhookRequestAuth(input: {
  security: NormalizedWebhookSecurityConfig;
  headers: Record<string, unknown>;
  rawBody: string;
  endpointKey: string;
  store: SqliteStore;
  secretService: SecretService;
}): Promise<{ ok: true } | { ok: false; statusCode: 401 | 403; message: string }> {
  const { security } = input;

  if (security.authMode === "none") {
    return { ok: true };
  }

  const secret = await input.secretService.resolveSecret(security.secretRef);
  if (!secret) {
    return {
      ok: false,
      statusCode: 401,
      message: "Webhook authentication is not configured correctly"
    };
  }

  const headers = input.headers;

  if (security.authMode === "bearer_token") {
    const headerValue = getHeaderValue(headers, security.authHeaderName);
    if (!headerValue) {
      return {
        ok: false,
        statusCode: 401,
        message: "Unauthorized webhook request"
      };
    }

    const token =
      security.authHeaderName === "authorization" && headerValue.toLowerCase().startsWith("bearer ")
        ? headerValue.slice(7).trim()
        : headerValue;

    if (!token || !safeEqualSecret(secret, token)) {
      return {
        ok: false,
        statusCode: 401,
        message: "Unauthorized webhook request"
      };
    }

    return { ok: true };
  }

  const signatureHeaderValue = getHeaderValue(headers, security.signatureHeaderName);
  const timestampHeaderValue = getHeaderValue(headers, security.timestampHeaderName);
  if (!signatureHeaderValue || !timestampHeaderValue) {
    return {
      ok: false,
      statusCode: 403,
      message: "Invalid webhook signature"
    };
  }

  const timestampMs = normalizeTimestampToMs(timestampHeaderValue);
  if (!timestampMs) {
    return {
      ok: false,
      statusCode: 403,
      message: "Invalid webhook signature timestamp"
    };
  }

  const nowMs = Date.now();
  const toleranceMs = security.replayToleranceSeconds * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) {
    return {
      ok: false,
      statusCode: 403,
      message: "Webhook signature is outside the allowed time window"
    };
  }

  const rawSignature = stripSignaturePrefix(signatureHeaderValue).toLowerCase();
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${timestampHeaderValue}.${input.rawBody}`)
    .digest("hex");

  if (!rawSignature || !safeEqualSecret(expectedSignature, rawSignature)) {
    return {
      ok: false,
      statusCode: 403,
      message: "Invalid webhook signature"
    };
  }

  input.store.clearExpiredWebhookSecurityState(new Date(nowMs).toISOString());
  const replayFingerprint = computeSha256Hex(`${input.endpointKey}|${timestampHeaderValue}|${rawSignature}`);
  if (input.store.hasWebhookReplayKey(replayFingerprint)) {
    return {
      ok: false,
      statusCode: 403,
      message: "Webhook replay detected"
    };
  }

  const replayExpiry = new Date(nowMs + toleranceMs).toISOString();
  input.store.saveWebhookReplayKey({
    replayKey: replayFingerprint,
    endpointKey: input.endpointKey,
    expiresAt: replayExpiry
  });

  return { ok: true };
}

export function createApp(config: AppConfig, store: SqliteStore, secretService: SecretService, authService: AuthService) {
  const app = Fastify({ logger: true });
  const providerRegistry = createDefaultProviderRegistry();
  const connectorRegistry = createDefaultConnectorRegistry();
  const mcpRegistry = createDefaultMCPRegistry();
  const agentRuntime = createDefaultAgentRuntime();

  type WorkflowExecutionEventHooks = {
    onNodeStart?: (event: { nodeId: string; nodeType: string; startedAt: string }) => Promise<void> | void;
    onNodeComplete?: (event: {
      nodeId: string;
      nodeType: string;
      status: string;
      completedAt: string;
      durationMs: number;
      output?: unknown;
      error?: string;
    }) => Promise<void> | void;
    onLLMDelta?: (event: { nodeId: string; delta: string; index: number }) => Promise<void> | void;
  };

  const runWorkflowExecution = async (input: {
    workflow: Workflow;
    webhookPayload?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    systemPrompt?: string;
    userPrompt?: string;
    sessionId?: string;
    directInput?: Record<string, unknown>;
    executionId?: string;
    triggerType?: string;
    triggeredBy?: string;
    resumeState?: WorkflowExecutionState;
    approvalDecision?: {
      decision: "approve" | "reject";
      actedBy?: string;
      reason?: string;
    };
    hooks?: WorkflowExecutionEventHooks;
  }) => {
    return executeWorkflow(
      {
        workflow: input.workflow,
        input: input.directInput,
        webhookPayload: input.webhookPayload,
        variables: input.variables,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        sessionId: input.sessionId,
        executionId: input.executionId,
        triggerType: input.triggerType,
        triggeredBy: input.triggeredBy,
        resumeState: input.resumeState,
        approvalDecision: input.approvalDecision
      },
      {
        providerRegistry,
        connectorRegistry,
        mcpRegistry,
        agentRuntime,
        memoryStore: {
          loadMessages: async (namespace, sessionId) => store.loadSessionMemory(namespace, sessionId),
          saveMessages: async (namespace, sessionId, messages) => {
            store.saveSessionMemory(namespace, sessionId, messages);
          }
        },
        resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
        persistPausedExecution: async (paused) => {
          store.saveWorkflowExecutionState({
            id: paused.executionId,
            workflowId: paused.workflowId,
            workflowName: paused.workflowName,
            status: "waiting_approval",
            waitingNodeId: paused.waitingNodeId,
            approvalMessage: paused.approvalMessage,
            timeoutMinutes: paused.timeoutMinutes,
            triggerType: paused.triggerType,
            triggeredBy: paused.triggeredBy,
            startedAt: paused.startedAt,
            state: paused.state
          });
        },
        onNodeStart: input.hooks?.onNodeStart,
        onNodeComplete: input.hooks?.onNodeComplete,
        onLLMDelta: input.hooks?.onLLMDelta
      }
    );
  };

  const parseWebhookRunInput = (payload: unknown) => {
    let body = asRecord(payload);
    if (typeof payload === "string" && payload.trim()) {
      try {
        const parsed = JSON.parse(payload);
        body = asRecord(parsed);
      } catch {
        body = {};
      }
    }
    const userPromptRaw =
      typeof body.user_prompt === "string"
        ? body.user_prompt
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    const userPrompt = userPromptRaw.trim();
    const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : "";
    const sessionId = normalizeSessionId(
      typeof body.sessionId === "string" ? body.sessionId : undefined,
      typeof body.session_id === "string" ? body.session_id : undefined
    );
    const variables = body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : undefined;

    return {
      body,
      userPrompt,
      systemPrompt,
      sessionId,
      variables
    };
  };

  const persistExecutionHistory = (input: {
    executionId: string;
    workflow: Workflow;
    result: Awaited<ReturnType<typeof runWorkflowExecution>>;
    triggerType?: string;
    triggeredBy?: string;
    requestInput?: unknown;
  }) => {
    if (input.result.status === "waiting_approval") {
      return;
    }

    store.saveExecutionHistory({
      id: input.executionId,
      workflowId: input.workflow.id,
      workflowName: input.workflow.name,
      status: input.result.status,
      startedAt: input.result.startedAt,
      completedAt: input.result.completedAt,
      durationMs: toDurationMs(input.result.startedAt, input.result.completedAt),
      triggerType: input.triggerType,
      triggeredBy: input.triggeredBy,
      inputJson: redactSensitiveInput(input.requestInput),
      outputJson: input.result.output,
      nodeResultsJson: input.result.nodeResults,
      error: input.result.error
    });

    store.deleteWorkflowExecution(input.executionId);
  };

  const rolePriority: Record<UserRole, number> = {
    viewer: 1,
    operator: 2,
    builder: 3,
    admin: 4
  };

  const hasRequiredRole = (user: SafeUser, allowedRoles: UserRole[]) => {
    return allowedRoles.some((role) => rolePriority[user.role] >= rolePriority[role]);
  };

  const getSessionIdFromRequest = (request: { cookies: Record<string, string | undefined> }) => {
    return request.cookies[config.SESSION_COOKIE_NAME] ?? "";
  };

  const setSessionCookie = (reply: FastifyReply, sessionId: string) => {
    reply.setCookie(config.SESSION_COOKIE_NAME, sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.COOKIE_SECURE,
      maxAge: config.SESSION_TTL_HOURS * 60 * 60
    });
  };

  const clearSessionCookie = (reply: FastifyReply) => {
    reply.clearCookie(config.SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.COOKIE_SECURE
    });
  };

  const deny = (reply: FastifyReply, code: 401 | 403, message: string) => {
    reply.code(code).send({ error: message });
  };

  const requireRole = async (
    request: { cookies: Record<string, string | undefined> },
    reply: FastifyReply,
    allowedRoles: UserRole[]
  ): Promise<SafeUser | null> => {
    const sessionId = getSessionIdFromRequest(request);
    if (!sessionId) {
      deny(reply, 401, "Authentication required");
      return null;
    }

    const user = authService.getSessionUser(sessionId);
    if (!user) {
      clearSessionCookie(reply);
      deny(reply, 401, "Session expired or invalid");
      return null;
    }

    if (!hasRequiredRole(user, allowedRoles)) {
      deny(reply, 403, "Insufficient permissions");
      return null;
    }

    return user;
  };

  app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true
  });

  app.register(cookie);
  app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  app.get("/health", async () => {
    return {
      ok: true,
      now: new Date().toISOString()
    };
  });

  app.get("/widget.js", async (_request, reply) => {
    const widgetBundlePath = resolveWidgetBundlePath();
    if (!fs.existsSync(widgetBundlePath)) {
      reply.code(404);
      return {
        error: "widget.js is not available. Build apps/web in widget mode first."
      };
    }

    const bundle = fs.readFileSync(widgetBundlePath, "utf8");
    reply.header("content-type", "application/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(bundle);
  });

  app.post<{ Body: unknown }>("/api/auth/register", async (request, reply) => {
    const parsed = authRegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid registration payload",
        details: parsed.error.issues
      };
    }

    const existingUsers = authService.countUsers();
    let actor: SafeUser | null = null;

    if (existingUsers > 0 && !config.AUTH_ALLOW_PUBLIC_REGISTER) {
      actor = await requireRole(request, reply, ["admin"]);
      if (!actor) {
        return;
      }
    } else if (existingUsers > 0 && config.AUTH_ALLOW_PUBLIC_REGISTER) {
      actor = authService.getSessionUser(getSessionIdFromRequest(request));
    }

    const requestedRole: UserRole = parsed.data.role ?? (parsed.data.admin ? "admin" : "viewer");
    let role: UserRole = requestedRole;
    if (existingUsers === 0) {
      role = parsed.data.role ?? "admin";
    } else if (!actor) {
      role = "viewer";
    } else if (role === "admin" && actor.role !== "admin") {
      reply.code(403);
      return { error: "Only admins can create admin users" };
    }

    try {
      const user = authService.register({
        email: parsed.data.email,
        password: parsed.data.password,
        role
      });
      return { user };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Registration failed"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/auth/login", async (request, reply) => {
    const parsed = authLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid login payload",
        details: parsed.error.issues
      };
    }

    try {
      const result = authService.login(parsed.data.email, parsed.data.password);
      setSessionCookie(reply, result.sessionId);
      return {
        user: result.user,
        expiresAt: result.expiresAt
      };
    } catch (error) {
      reply.code(401);
      return {
        error: error instanceof Error ? error.message : "Invalid credentials"
      };
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = getSessionIdFromRequest(request);
    if (sessionId) {
      authService.logout(sessionId);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }
    return { user };
  });

  app.get("/api/definitions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    return {
      nodes: nodeDefinitions,
      providers: providerRegistry.listDefinitions(),
      connectors: connectorRegistry.listDefinitions(),
      mcpServers: mcpRegistry.listDefinitions()
    };
  });

  app.get("/api/workflows", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }
    return store.listWorkflows();
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return workflow;
  });

  app.post<{ Body: unknown }>("/api/workflows", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow payload",
        details: parsed.error.issues
      };
    }

    const validation = validateWorkflowGraph(parsed.data);
    if (!validation.valid) {
      reply.code(400);
      return {
        error: `Workflow validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        validation
      };
    }

    return store.upsertWorkflow(parsed.data);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow payload",
        details: parsed.error.issues
      };
    }

    if (parsed.data.id !== request.params.id) {
      reply.code(400);
      return { error: "Workflow ID mismatch between path and payload" };
    }

    const validation = validateWorkflowGraph(parsed.data);
    if (!validation.valid) {
      reply.code(400);
      return {
        error: `Workflow validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        validation
      };
    }

    return store.upsertWorkflow(parsed.data);
  });

  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    try {
      const deleted = store.deleteWorkflow(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: "Workflow not found" };
      }

      return { ok: true };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to delete workflow"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/workflows/import", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = workflowImportSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid import payload", details: parsed.error.issues };
    }

    try {
      const workflow = parsed.data.json
        ? importWorkflowFromJson(parsed.data.json)
        : workflowSchema.parse(parsed.data.workflow);

      const validation = validateWorkflowGraph(workflow);
      if (!validation.valid) {
        reply.code(400);
        return {
          error: `Workflow validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`,
          validation
        };
      }

      return store.upsertWorkflow(workflow);
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to import workflow"
      };
    }
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/export", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return {
      json: exportWorkflowToJson(workflow)
    };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/validate", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return validateWorkflowGraph(workflow);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/execute", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }

    const executionId = crypto.randomUUID();
    const result = await runWorkflowExecution({
      workflow,
      directInput: parsed.data.input,
      variables: parsed.data.variables,
      systemPrompt: parsed.data.system_prompt,
      userPrompt: parsed.data.user_prompt,
      sessionId: normalizeSessionId(parsed.data.sessionId, parsed.data.session_id),
      executionId,
      triggerType: "manual",
      triggeredBy: user.email
    });

    persistExecutionHistory({
      executionId,
      workflow,
      result,
      triggerType: "manual",
      triggeredBy: user.email,
      requestInput: parsed.data
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/execute/stream", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }

    const executionId = crypto.randomUUID();
    let streamClosed = false;
    request.raw.on("close", () => {
      streamClosed = true;
    });

    const sendSseEvent = (event: string, payload: unknown) => {
      if (streamClosed) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      const serialized = JSON.stringify(payload ?? null);
      for (const line of serialized.split("\n")) {
        reply.raw.write(`data: ${line}\n`);
      }
      reply.raw.write("\n");
    };

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    if (typeof reply.raw.flushHeaders === "function") {
      reply.raw.flushHeaders();
    }

    try {
      const result = await runWorkflowExecution({
        workflow,
        directInput: parsed.data.input,
        variables: parsed.data.variables,
        systemPrompt: parsed.data.system_prompt,
        userPrompt: parsed.data.user_prompt,
        sessionId: normalizeSessionId(parsed.data.sessionId, parsed.data.session_id),
        executionId,
        triggerType: "manual_stream",
        triggeredBy: user.email,
        hooks: {
          onNodeStart: (event) => {
            sendSseEvent("node_start", event);
          },
          onNodeComplete: (event) => {
            sendSseEvent("node_complete", event);
          },
          onLLMDelta: (event) => {
            sendSseEvent("llm_delta", event);
          }
        }
      });

      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "manual_stream",
        triggeredBy: user.email,
        requestInput: parsed.data
      });

      sendSseEvent("result", result);
      if (result.status === "error") {
        sendSseEvent("error", { message: result.error ?? "Execution failed" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Execution failed";
      sendSseEvent("error", { message });
    } finally {
      if (!streamClosed) {
        reply.raw.end();
      }
    }
  });

  app.post<{ Body: unknown }>("/api/code-node/test", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = codeNodeTestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid Code Node test payload",
        details: parsed.error.issues
      };
    }

    try {
      const result = await executeCodeNodeSandbox({
        code: parsed.data.code,
        timeoutMs: parsed.data.timeout,
        input: parsed.data.input ?? {}
      });
      return result;
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Code node test failed"
      };
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/executions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const query = asRecord(request.query);
    const page = Number(query.page);
    const pageSize = Number(query.pageSize);

    return store.listExecutionHistory({
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
      status: typeof query.status === "string" && query.status.trim() ? query.status.trim() : undefined,
      workflowId: typeof query.workflowId === "string" && query.workflowId.trim() ? query.workflowId.trim() : undefined,
      triggerType:
        typeof query.triggerType === "string" && query.triggerType.trim() ? query.triggerType.trim() : undefined
    });
  });

  app.get<{ Params: { id: string } }>("/api/executions/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const execution = store.getExecutionHistory(request.params.id);
    if (!execution) {
      reply.code(404);
      return { error: "Execution not found" };
    }

    return execution;
  });

  app.get("/api/approvals", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) {
      return;
    }

    return {
      items: store.listPendingApprovals()
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/approve", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) {
      return;
    }

    const pending = store.getWorkflowExecutionState(request.params.id);
    if (!pending || pending.status !== "waiting_approval") {
      reply.code(404);
      return { error: "Pending approval not found" };
    }

    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) {
      reply.code(400);
      return { error: "Stored execution state is invalid and cannot be resumed" };
    }

    const result = await runWorkflowExecution({
      workflow: state.workflow,
      executionId: pending.id,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      resumeState: state,
      approvalDecision: {
        decision: "approve",
        actedBy: user.email
      }
    });

    persistExecutionHistory({
      executionId: pending.id,
      workflow: state.workflow,
      result,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      requestInput: { decision: "approve", approvalId: pending.id }
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/reject", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) {
      return;
    }

    const pending = store.getWorkflowExecutionState(request.params.id);
    if (!pending || pending.status !== "waiting_approval") {
      reply.code(404);
      return { error: "Pending approval not found" };
    }

    const parsed = approvalDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid rejection payload",
        details: parsed.error.issues
      };
    }

    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) {
      reply.code(400);
      return { error: "Stored execution state is invalid and cannot be resumed" };
    }

    const result = await runWorkflowExecution({
      workflow: state.workflow,
      executionId: pending.id,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      resumeState: state,
      approvalDecision: {
        decision: "reject",
        actedBy: user.email,
        reason: parsed.data.reason
      }
    });

    persistExecutionHistory({
      executionId: pending.id,
      workflow: state.workflow,
      result,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      requestInput: { decision: "reject", approvalId: pending.id, reason: parsed.data.reason }
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Body: unknown }>("/api/webhooks/execute", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = agentWebhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid webhook payload",
        details: parsed.error.issues
      };
    }

    const workflow = await selectWebhookWorkflow(store, parsed.data.workflow_id);
    if (!workflow) {
      reply.code(404);
      return { error: "No workflows available" };
    }

    const executionId = crypto.randomUUID();
    const result = await runWorkflowExecution({
      workflow,
      webhookPayload: {
        system_prompt: parsed.data.system_prompt,
        user_prompt: parsed.data.user_prompt,
        session_id: parsed.data.session_id,
        variables: parsed.data.variables
      },
      variables: parsed.data.variables,
      systemPrompt: parsed.data.system_prompt,
      userPrompt: parsed.data.user_prompt,
      sessionId: parsed.data.session_id,
      executionId,
      triggerType: "webhook_api",
      triggeredBy: user.email
    });

    persistExecutionHistory({
      executionId,
      workflow,
      result,
      triggerType: "webhook_api",
      triggeredBy: user.email,
      requestInput: parsed.data
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return {
      ...result,
      selectedWorkflowId: workflow.id
    };
  });

  const registerConfiguredWebhookRoute = (routePath: "/webhook/:path" | "/webhook-test/:path") => {
    const isTestRoute = routePath.startsWith("/webhook-test");
    app.route<{ Params: { path: string }; Body: unknown }>({
      method: ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"],
      url: routePath,
      config: {
        rawBody: true
      },
      handler: async (request, reply) => {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Allow-Methods", "DELETE, GET, OPTIONS, PATCH, POST, PUT");
        reply.header(
          "Access-Control-Allow-Headers",
          "content-type,authorization,x-webhook-signature,x-webhook-timestamp,idempotency-key"
        );

        if (request.method === "OPTIONS") {
          reply.code(204);
          return null;
        }

        const match = await selectWebhookByPath(store, request.params.path, request.method);
        if (!match) {
          reply.code(404);
          return {
            error: "No webhook endpoint matches this path and method",
            path: request.params.path,
            method: request.method
          };
        }

        const security = normalizeWebhookSecurityConfig(match.endpoint.config);
        const endpointKey = `${isTestRoute ? "test" : "prod"}:${match.workflow.id}:${match.endpoint.nodeId}:${match.endpoint.method}:${match.endpoint.path.toLowerCase()}`;
        const rawBody = getRawRequestBody(request as unknown as { rawBody?: unknown; body: unknown });

        const authResult = await verifyWebhookRequestAuth({
          security,
          headers: request.headers as Record<string, unknown>,
          rawBody,
          endpointKey,
          store,
          secretService
        });

        if (!authResult.ok) {
          reply.code(authResult.statusCode);
          return { error: authResult.message };
        }

        const parsedInput = parseWebhookRunInput(request.body);
        if (!parsedInput.userPrompt) {
          reply.code(400);
          return {
            error: "Webhook payload must include 'user_prompt' (or 'prompt')."
          };
        }

        let idempotencyKey: string | undefined;
        let replayingExistingResult = false;
        if (security.idempotencyEnabled) {
          store.clearExpiredWebhookSecurityState();
          idempotencyKey = getHeaderValue(request.headers as Record<string, unknown>, security.idempotencyHeaderName);
          if (!idempotencyKey) {
            reply.code(400);
            return {
              error: `Missing required idempotency header '${security.idempotencyHeaderName}'.`
            };
          }

          const now = Date.now();
          const requestHash = computeSha256Hex(rawBody);
          const existing = store.getWebhookIdempotency({
            endpointKey,
            idempotencyKey
          });

          if (existing) {
            if (existing.requestHash !== requestHash) {
              reply.code(409);
              return {
                error: "Idempotency key already used with a different request payload."
              };
            }

            if (existing.status === "pending") {
              reply.code(409);
              return {
                error: "Request with this idempotency key is already in progress."
              };
            }

            if (existing.result && typeof existing.result === "object") {
              replayingExistingResult = true;
              return {
                ...(existing.result as Record<string, unknown>),
                idempotency: {
                  key: idempotencyKey,
                  reused: true
                }
              };
            }
          }

          const idempotencyExpiry = new Date(now + DEFAULT_IDEMPOTENCY_TTL_SECONDS * 1000).toISOString();
          try {
            store.saveWebhookIdempotencyPending({
              endpointKey,
              idempotencyKey,
              requestHash,
              expiresAt: idempotencyExpiry
            });
          } catch {
            const latest = store.getWebhookIdempotency({
              endpointKey,
              idempotencyKey
            });
            if (latest && latest.requestHash !== requestHash) {
              reply.code(409);
              return {
                error: "Idempotency key already used with a different request payload."
              };
            }
            if (latest && latest.status === "pending") {
              reply.code(409);
              return {
                error: "Request with this idempotency key is already in progress."
              };
            }
            if (latest?.result && typeof latest.result === "object") {
              return {
                ...(latest.result as Record<string, unknown>),
                idempotency: {
                  key: idempotencyKey,
                  reused: true
                }
              };
            }
          }
        }

        const executionId = crypto.randomUUID();
        const result = await runWorkflowExecution({
          workflow: match.workflow,
          webhookPayload: {
            ...parsedInput.body,
            system_prompt: parsedInput.systemPrompt,
            user_prompt: parsedInput.userPrompt,
            session_id: parsedInput.sessionId,
            variables: parsedInput.variables
          },
          variables: parsedInput.variables,
          systemPrompt: parsedInput.systemPrompt,
          userPrompt: parsedInput.userPrompt,
          sessionId: parsedInput.sessionId,
          executionId,
          triggerType: isTestRoute ? "webhook_test" : "webhook",
          triggeredBy: "webhook"
        });

        persistExecutionHistory({
          executionId,
          workflow: match.workflow,
          result,
          triggerType: isTestRoute ? "webhook_test" : "webhook",
          triggeredBy: "webhook",
          requestInput: parsedInput.body
        });

        if (result.status === "error") {
          reply.code(400);
        }

        const responsePayload = {
          ...result,
          selectedWorkflowId: match.workflow.id,
          webhookPath: match.endpoint.path,
          webhookMethod: match.endpoint.method,
          idempotency: security.idempotencyEnabled
            ? {
                key: idempotencyKey ?? null,
                reused: replayingExistingResult
              }
            : undefined
        };

        if (security.idempotencyEnabled && idempotencyKey) {
          store.saveWebhookIdempotencyResult({
            endpointKey,
            idempotencyKey,
            status: result.status,
            result: responsePayload
          });
        }

        return responsePayload;
      }
    });
  };

  registerConfiguredWebhookRoute("/webhook/:path");
  registerConfiguredWebhookRoute("/webhook-test/:path");

  app.post<{ Body: unknown }>("/api/secrets", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = secretCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid secret payload",
        details: parsed.error.issues
      };
    }

    const secretRef = secretService.createSecret(parsed.data);
    return {
      id: secretRef.secretId,
      name: parsed.data.name,
      provider: parsed.data.provider
    };
  });

  app.get("/api/secrets", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    return secretService.listSecrets();
  });

  app.post<{ Body: unknown }>("/api/mcp/discover-tools", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = mcpDiscoverSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid MCP discover payload",
        details: parsed.error.issues
      };
    }

    try {
      const serverConfig: MCPServerConfig = {
        serverId: parsed.data.serverId,
        label: parsed.data.label,
        connection: parsed.data.connection,
        secretRef: parsed.data.secretRef,
        allowedTools: parsed.data.allowedTools
      };

      const tools = await mcpRegistry.get(parsed.data.serverId).discoverTools(serverConfig, {
        resolveSecret: (secretRef) => secretService.resolveSecret(secretRef)
      });

      return {
        serverId: parsed.data.serverId,
        tools
      };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to discover MCP tools"
      };
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    app.log.error({ err: secretService.redact(message) }, "Unhandled API error");
    reply.code(500).send({
      error: "Internal server error"
    });
  });

  return app;
}
