/**
 * 12.6b — the OpenAI-compatible `/v1` AI gateway: `GET /v1/models`, `POST /v1/chat/completions` (JSON or SSE) and
 * `POST /v1/embeddings`, for applications outside L2M.
 *
 * Callers authenticate with an MCP gateway client token (A1) and name a route alias as `model` (A2). Admission order:
 * client token (and its certificate and address pins) -> route granted to the client -> rate limit (the client's own, else the route set's default) ->
 * budgets (the client's, the route set's project's, the deployment's) -> model allowlist -> Content rules on the prompt ->
 * provider -> Content rules on the answer -> usage row -> response. Errors use the OpenAI envelope (A9). Until an admin
 * creates a route set and grants it to a client (A12) no request finds a route: a bad token gets 401, every model name 404, and
 * /v1/models lists nothing. Other statuses (400, 403 for network controls, 413, 415) come from malformed or refused requests.
 *
 * Only metadata is recorded per request (A5): tokens, cost, latency, model, finish reason and the rule outcome, in
 * ai_gateway_requests, written before the response ends (A10) so budget checks on any replica see it. Every request
 * that reached the provider is charged: when it gave no usage, the row carries an estimate and says so.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  LLMProviderError,
  chargedUsage,
  estimateAnswerTokens,
  estimateRequestTokens,
  isModelNotAllowedError,
  providerCallOptionSupport,
  unseenOutputTokens,
  type EmbeddingProviderRegistry,
  type LLMStreamChunk,
  type ProviderExecutionContext,
  type ProviderRegistry,
  type UsageEstimate
} from "@ai-orchestrator/provider-sdk";
import {
  effectiveGatewayRateLimit,
  effectiveModelName,
  openAiChatCompletionRequestSchema,
  openAiEmbeddingsRequestSchema,
  type AiGatewayGuardOutcome as RecordedGuardOutcome,
  type AiGatewayRequestRecord,
  type AiGatewayRequestStatus,
  type AiGatewayRoute,
  type AiGatewayRouteSet,
  type LLMFinishReason,
  type LLMProviderConfig,
  type LLMUsage,
  type McpClient,
  type McpToolPolicySubject,
  type SecretReference
} from "@ai-orchestrator/shared";
import type { z } from "zod";
import type { Store } from "./db/store.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { BudgetCheckContext, BudgetService } from "./services/budget-service.js";
import { BudgetUnavailableError } from "./services/budget-service.js";
import type { GuardService } from "./services/guard-service.js";
import { GatewayClientLimiter } from "./services/mcp-gateway-limits.js";
import { McpClientService, resolveMcpClientSubject } from "./services/mcp-client-service.js";
import { createMcpClientAdmission } from "./mcp-client-admission.js";
import type { NetworkControls } from "./network-controls.js";
import { startSseHeartbeat } from "./sse-heartbeat.js";
import { retryAfterSeconds } from "./run-helpers.js";
import {
  checkAiGatewayAnswer,
  checkAiGatewayRequest,
  outputGuardMode,
  streamCheckDue,
  streamReleaseLength,
  type AiGatewayAnswer,
  type AiGatewayGuardScope,
  type AiGatewayOutputMode
} from "./services/ai-gateway-guard.js";
import {
  AiGatewayHttpError,
  aiGatewayErrors,
  argumentsText,
  base64Embedding,
  chatChunk,
  chatCompletionBody,
  issueParam,
  openAiToolCalls,
  toCallOptions,
  toChatMessages,
  toToolDefinitions,
  usageChunk
} from "./services/ai-gateway-wire.js";

/** One model call to check against the model allowlist. `model` is the name the provider is sent. */
export interface AiGatewayModelCheck {
  (
    scope: { projectId: string | null; clientId: string; routeSetId: string; requestId: string },
    call: { providerId: string; model: string; operation: "generate" | "stream" | "embed" }
  ): Promise<void>;
}

export interface AiGatewayDeps {
  app: FastifyInstance;
  config: { SSE_HEARTBEAT_INTERVAL_MS: number };
  store: Store;
  providerRegistry: ProviderRegistry;
  embeddingRegistry: EmbeddingProviderRegistry;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  redact: (value: string) => string;
  auditRaw: (event: AuditEventInput) => void | Promise<void>;
  /** Absent: /v1 runs no content rules. */
  guard?: GuardService;
  /** Absent: no budget checks. */
  budgets?: Pick<BudgetService, "checkBlock" | "recordGatewayUsage">;
  /** Per-client rate limits (shared across replicas in cluster mode); absent: counted in this process. */
  limiter?: GatewayClientLimiter;
  /** The client's own address list and certificate pins; absent: a client with either is refused. */
  network?: NetworkControls;
  /** A request's cost from the pricing table; null when the model has no price. */
  priceRequest?: (providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number) => number | null;
  /**
   * The model allowlist: throws to refuse (an error named `ModelNotAllowedError` answers 403, any other 503). Absent:
   * every model is allowed.
   */
  checkModel?: AiGatewayModelCheck;
  /** Boundary and held-back tail sizes for streamed content rule checks (tests). */
  streamCheck?: { minChars?: number; maxChars?: number; holdChars?: number };
}

interface Admitted {
  requestId: string;
  startedAt: number;
  client: McpClient;
  subject: McpToolPolicySubject;
  route: AiGatewayRoute;
  routeSet: AiGatewayRouteSet;
  /** Frees the concurrency slot (call once the request ends). */
  release: () => void;
  guard: AiGatewayGuardScope | null;
  outputMode: AiGatewayOutputMode;
  /** Aborted when the caller goes away: the provider call stops. */
  abort: AbortController;
}

const REFUSAL_AUDIT_EVERY_MS = 60_000;

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function sendError(reply: FastifyReply, error: AiGatewayHttpError): FastifyReply {
  if (error.retryAfterSeconds !== undefined) reply.header("retry-after", String(error.retryAfterSeconds));
  if (error.status === 401) reply.header("www-authenticate", 'Bearer realm="l2m-ai-gateway"');
  return reply.code(error.status).header("content-type", "application/json; charset=utf-8").send(error.body());
}

function usageTokens(usage: LLMUsage | undefined): { input: number; output: number; cached: number; total: number } {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return { input, output, cached: usage?.cachedInputTokens ?? 0, total: usage?.totalTokens ?? input + output };
}

function zodError(error: z.ZodError): AiGatewayHttpError {
  const issue = error.issues[0];
  const param = issue ? issueParam(issue.path) : null;
  return aiGatewayErrors.invalidRequest(issue ? `${param ? `${param}: ` : ""}${issue.message}` : "Invalid request body.", param);
}

/** Collects streamed tool-call deltas into whole calls, by index (OpenAI family) or id. */
class ToolCallCollector {
  readonly calls: Array<{ id: string; name: string; arguments: string }> = [];
  private last = -1;

  /** Adds a delta; returns the index it belongs to. */
  add(chunk: Extract<LLMStreamChunk, { type: "tool_call_delta" }>): number {
    let index = chunk.index;
    if (index === undefined) {
      const byId = chunk.toolCallId ? this.calls.findIndex((call) => call.id === chunk.toolCallId) : -1;
      index = byId >= 0 ? byId : chunk.toolCallId || this.last < 0 ? this.calls.length : this.last;
    }
    while (this.calls.length <= index) this.calls.push({ id: "", name: "", arguments: "" });
    const call = this.calls[index]!;
    if (chunk.toolCallId) call.id = chunk.toolCallId;
    if (chunk.name) call.name = chunk.name;
    if (chunk.argumentsDelta) call.arguments += chunk.argumentsDelta;
    this.last = index;
    return index;
  }

  complete(): Array<{ id: string; name: string; arguments: string }> {
    return this.calls.map((call, index) => ({ id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || "{}" }));
  }
}

/** Writes an OpenAI-style event stream: `data: <json>` frames, comment heartbeats, `data: [DONE]` at the end. */
class OpenAiSseWriter {
  private started = false;
  private stopHeartbeat: (() => void) | null = null;

  constructor(
    private readonly request: FastifyRequest,
    private readonly reply: FastifyReply,
    private readonly heartbeatMs: number
  ) {}

  get isStarted(): boolean {
    return this.started;
  }

  get closed(): boolean {
    return this.reply.raw.writableEnded || this.reply.raw.destroyed;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Headers set by hooks (CORS, security headers) are not flushed for a hijacked reply.
    const hookHeaders: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(this.reply.getHeaders())) {
      if (value !== undefined) hookHeaders[name] = value;
    }
    this.reply.hijack();
    this.reply.raw.writeHead(200, {
      ...hookHeaders,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": this.request.id
    });
    this.stopHeartbeat = startSseHeartbeat(this.reply.raw, this.heartbeatMs);
  }

  data(payload: unknown): void {
    if (!this.started) this.start();
    if (this.closed) return;
    this.reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  end(): void {
    this.stopHeartbeat?.();
    if (!this.started || this.closed) return;
    this.reply.raw.write("data: [DONE]\n\n");
    this.reply.raw.end();
  }
}

export function registerAiGatewayRoutes(deps: AiGatewayDeps): void {
  const { app, store } = deps;
  const clientService = new McpClientService(store);
  const limiter = deps.limiter ?? new GatewayClientLimiter();
  const refusalAuditedAt = new Map<string, number>();

  const audit = async (event: AuditEventInput) => {
    try {
      await deps.auditRaw(event);
    } catch (error) {
      app.log.warn({ err: error instanceof Error ? error.message : String(error) }, "AI gateway audit event could not be written");
    }
  };

  const clientAdmission = createMcpClientAdmission({
    ...(deps.network ? { network: deps.network } : {}),
    auditRaw: audit,
    auditMetadata: { endpoint: "ai_gateway" }
  });

  /** Refusals (rate limit, budget, allowlist) are audited at most once a minute per client and kind. */
  const auditRefusal = async (client: McpClient, routeSet: AiGatewayRouteSet, eventType: string, metadata: Record<string, unknown>) => {
    const key = `${client.id}:${eventType}`;
    const now = Date.now();
    const last = refusalAuditedAt.get(key);
    if (last !== undefined && now - last < REFUSAL_AUDIT_EVERY_MS) return;
    if (refusalAuditedAt.size > 10_000) refusalAuditedAt.clear();
    refusalAuditedAt.set(key, now);
    await audit({
      category: "system",
      eventType,
      action: "execute",
      outcome: "denied",
      actor: { type: "api_key", email: client.name },
      resourceType: "ai_gateway_route_set",
      resourceId: routeSet.id,
      projectId: routeSet.projectId,
      metadata: { clientId: client.id, ...metadata }
    });
  };

  const authenticate = async (request: FastifyRequest): Promise<{ client: McpClient; subject: McpToolPolicySubject }> => {
    const match = (headerValue(request, "authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!match) throw aiGatewayErrors.invalidApiKey("An API key is required: send Authorization: Bearer <client token>.");
    const verification = await clientService.verify(match[1]!);
    if (!verification.ok) {
      throw aiGatewayErrors.invalidApiKey(
        verification.reason === "revoked" ? "This client token has been revoked." : verification.reason === "expired" ? "This client token has expired." : "Invalid client token."
      );
    }
    // 13.2 — the token is the MCP gateway's, and so are its pins: the same checks, answered in the OpenAI format.
    const certificateRefusal = await clientAdmission.certificateRefusal(request, verification.client);
    if (certificateRefusal) throw aiGatewayErrors.invalidApiKey(certificateRefusal);
    if (!(await clientAdmission.addressAdmitted(request, verification.client))) throw aiGatewayErrors.networkDenied();
    return { client: verification.client, subject: await resolveMcpClientSubject(store, verification.client) };
  };

  const parseBody = (request: FastifyRequest): unknown => {
    const raw = typeof request.body === "string" ? request.body : "";
    try {
      return JSON.parse(raw);
    } catch {
      throw aiGatewayErrors.invalidRequest("The request body is not valid JSON.");
    }
  };

  /** Steps 2-7 of the admission order, for a request whose body names `model`. */
  const admit = async (
    request: FastifyRequest,
    reply: FastifyReply,
    auth: { client: McpClient; subject: McpToolPolicySubject },
    model: string,
    kind: "chat" | "embedding",
    operation: "generate" | "stream" | "embed"
  ): Promise<Admitted> => {
    const requestId = `aigw_${crypto.randomUUID()}`;
    const { client, subject } = auth;
    const resolved = await store.resolveAiGatewayRoute(client.id, model);
    if (!resolved) throw aiGatewayErrors.modelNotFound(model);
    const { route, routeSet } = resolved;
    if (route.kind !== kind) {
      throw aiGatewayErrors.invalidRequest(
        kind === "embedding" ? `The model '${model}' is a chat model, not an embedding model.` : `The model '${model}' is an embedding model; use /v1/embeddings.`,
        "model",
        "model_not_supported"
      );
    }

    // Rate limits: the client's own (one allowance across the MCP gateway and /v1) and the set's, per client. Both apply.
    const held: Array<() => void> = [];
    const release = () => {
      for (const releaseSlot of held) releaseSlot();
    };
    const setLimitId = `ai:${routeSet.id}`;
    const limits = [
      effectiveGatewayRateLimit(client, { id: setLimitId, rateLimit: null }),
      effectiveGatewayRateLimit({ id: client.id, rateLimit: null }, { id: setLimitId, rateLimit: routeSet.rateLimit })
    ];
    for (const effective of limits) {
      if (!effective) continue;
      const key = effective.source === "client" ? effective.key : `client:${client.id}:aiset:${routeSet.id}`;
      const decision = await limiter.acquire(key, effective.limit);
      if (!decision.ok) {
        release();
        await auditRefusal(client, routeSet, "ai_gateway.rate_limited", { alias: route.alias, reason: decision.reason, source: effective.source });
        throw aiGatewayErrors.rateLimited(decision.message, Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
      }
      held.push(decision.release);
    }
    try {
      if (deps.budgets) {
        const ctx: BudgetCheckContext = {
          workflowId: null,
          projectId: routeSet.projectId,
          userEmail: null,
          userId: null,
          client: { id: client.id, name: client.name },
          toolsetProjectId: routeSet.projectId
        };
        let blocked;
        try {
          blocked = await deps.budgets.checkBlock(ctx);
        } catch (error) {
          if (error instanceof BudgetUnavailableError) throw aiGatewayErrors.unavailable("Budgets could not be checked for this request, so it was not sent. Try again.");
          throw error;
        }
        if (blocked) {
          await auditRefusal(client, routeSet, "ai_gateway.budget_blocked", { alias: route.alias, budgetId: blocked.budget.id, period: blocked.budget.period });
          throw aiGatewayErrors.insufficientQuota(`${blocked.message} Requests are refused until the budget resets or is raised.`, retryAfterSeconds(blocked.budget.period));
        }
      }
      if (deps.checkModel) {
        try {
          await deps.checkModel({ projectId: routeSet.projectId, clientId: client.id, routeSetId: routeSet.id, requestId }, { providerId: route.providerId, model: effectiveModelName(route), operation });
        } catch (error) {
          if (error instanceof Error && error.name === "ModelNotAllowedError") {
            await auditRefusal(client, routeSet, "ai_gateway.model_not_allowed", { alias: route.alias, providerId: route.providerId, model: route.model });
            throw aiGatewayErrors.modelNotAllowed(model);
          }
          app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "AI gateway could not check the model allowlist; the request was refused");
          throw aiGatewayErrors.unavailable("The model allowlist could not be checked for this request, so it was not sent. Try again.");
        }
      }
      let guard: AiGatewayGuardScope | null = null;
      let outputMode: AiGatewayOutputMode = "none";
      if (deps.guard) {
        let resolution;
        try {
          ({ resolution } = await deps.guard.resolveGateway({ toolsetId: routeSet.id, clientId: client.id, projectId: routeSet.projectId, setScope: "ai_route_set" }));
        } catch (error) {
          app.log.warn({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "AI gateway could not read the rule set bindings for a request; it was refused");
          throw aiGatewayErrors.unavailable("Content rules could not be checked for this request, so it was not sent. Try again.");
        }
        if (resolution.stack.length > 0) {
          guard = {
            guard: deps.guard,
            resolution,
            requestId,
            routeSetId: routeSet.id,
            clientId: client.id,
            projectId: routeSet.projectId,
            alias: route.alias,
            subject,
            resolveSecret: deps.resolveSecret,
            logger: (message, metadata) => app.log.warn({ metadata }, message)
          };
          outputMode = outputGuardMode(resolution.stack);
        }
      }
      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) abort.abort(new Error("The caller closed the connection."));
      });
      return { requestId, startedAt: Date.now(), client, subject, route, routeSet, release, guard, outputMode, abort };
    } catch (error) {
      release();
      throw error;
    }
  };

  const providerConfig = (route: AiGatewayRoute, overrides: { temperature?: number; maxTokens?: number } = {}): LLMProviderConfig => ({
    providerId: route.providerId,
    model: route.model,
    ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
    ...(route.secretRef ? { secretRef: route.secretRef } : {}),
    ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
    extra: route.extra
  });

  /** The route's own secret only: a request can never make the gateway resolve another secret. */
  const executionContext = (admitted: Admitted): ProviderExecutionContext => ({
    resolveSecret: async (secretRef) => {
      const own = admitted.route.secretRef?.secretId;
      if (!own || secretRef?.secretId !== own) return undefined;
      return await deps.resolveSecret({ secretId: own });
    },
    signal: admitted.abort.signal
  });

  /** The usage the provider reported, or none: zeros are a server that sent no numbers, and the caller must not read them as spend. */
  const reportedUsage = (usage: LLMUsage | undefined): LLMUsage | undefined =>
    usage && (usage.inputTokens || usage.outputTokens || usage.totalTokens) ? usage : undefined;

  /** A provider failure as the caller sees it: never the upstream text (it can name hosts or echo keys). */
  const upstreamFailure = (admitted: Admitted, error: unknown): AiGatewayHttpError => {
    // The list changed after admission: the provider registry's own check refused the call, so nothing was sent.
    if (isModelNotAllowedError(error)) return aiGatewayErrors.modelNotAllowed(admitted.route.alias);
    // Metadata only: some servers put the prompt in their error text, and the usage rows keep none of it either.
    app.log.warn(
      {
        requestId: admitted.requestId,
        alias: admitted.route.alias,
        providerId: admitted.route.providerId,
        errorName: error instanceof Error ? error.name : "unknown",
        upstreamStatus: error instanceof LLMProviderError ? error.statusCode : undefined
      },
      "AI gateway provider call failed"
    );
    if (error instanceof LLMProviderError && error.statusCode === 429) return aiGatewayErrors.upstreamRateLimited(30);
    return aiGatewayErrors.upstream(error instanceof LLMProviderError ? error.statusCode : undefined);
  };

  /**
   * The charge of a failed provider call: its input, since the request may have been billed and the gateway cannot
   * tell. The one exception is the provider registry's own refusal, when nothing was sent.
   */
  const failedCallCharge = (error: unknown, inputTokens: () => number): { estimate?: () => UsageEstimate } =>
    isModelNotAllowedError(error) ? {} : { estimate: () => ({ input: inputTokens(), output: 0 }) };

  const record = async (
    admitted: Admitted,
    input: {
      kind: "chat" | "embedding";
      stream: boolean;
      status: AiGatewayRequestStatus;
      httpStatus: number;
      finishReason?: string | null;
      usage?: LLMUsage;
      /** Set on every request that reached the provider: what to charge for what `usage` does not say. */
      estimate?: () => UsageEstimate;
      guardOutcome: RecordedGuardOutcome;
      errorCode?: string | null;
    }
  ) => {
    const charged = input.estimate ? chargedUsage(input.usage, input.estimate) : { usage: input.usage, estimated: false };
    const tokens = usageTokens(charged.usage);
    const costUsd = deps.priceRequest ? deps.priceRequest(admitted.route.providerId, admitted.route.model, tokens.input, tokens.output, tokens.cached) : null;
    const row: AiGatewayRequestRecord = {
      id: admitted.requestId,
      createdAt: new Date(admitted.startedAt).toISOString(),
      clientId: admitted.client.id,
      routeSetId: admitted.routeSet.id,
      routeId: admitted.route.id,
      projectId: admitted.routeSet.projectId,
      alias: admitted.route.alias,
      kind: input.kind,
      providerId: admitted.route.providerId,
      model: admitted.route.model,
      stream: input.stream,
      status: input.status,
      httpStatus: input.httpStatus,
      finishReason: input.finishReason ?? null,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedInputTokens: tokens.cached,
      totalTokens: tokens.total,
      usageEstimated: charged.estimated,
      costUsd: tokens.total > 0 ? costUsd : costUsd === null ? null : 0,
      latencyMs: Date.now() - admitted.startedAt,
      guardOutcome: input.guardOutcome,
      errorCode: input.errorCode ?? null
    };
    try {
      await store.insertAiGatewayRequest(row);
    } catch (error) {
      app.log.warn({ requestId: row.id, err: error instanceof Error ? error.message : String(error) }, "AI gateway usage row could not be written");
      return;
    }
    if (deps.budgets && tokens.total > 0) {
      const ctx: BudgetCheckContext & { executionId: string } = {
        workflowId: null,
        projectId: admitted.routeSet.projectId,
        userEmail: null,
        userId: null,
        client: { id: admitted.client.id, name: admitted.client.name },
        toolsetProjectId: admitted.routeSet.projectId,
        executionId: admitted.requestId
      };
      void deps.budgets.recordGatewayUsage(ctx).catch((error: unknown) => {
        app.log.warn({ err: error instanceof Error ? error.message : String(error) }, "AI gateway budget alerts could not be checked");
      });
    }
  };

  const auditGuardBlock = async (admitted: Admitted, channel: "prompt" | "final_output", verdict: { reason: string; categories: string[]; profiles: unknown[] }) => {
    await audit({
      category: "system",
      eventType: "ai_gateway.guard_blocked",
      action: "execute",
      outcome: "denied",
      actor: { type: "api_key", email: admitted.client.name },
      resourceType: "ai_gateway_route_set",
      resourceId: admitted.routeSet.id,
      projectId: admitted.routeSet.projectId,
      metadata: {
        clientId: admitted.client.id,
        alias: admitted.route.alias,
        executionId: admitted.requestId,
        channel,
        categories: verdict.categories,
        profiles: verdict.profiles,
        reason: deps.redact(verdict.reason)
      }
    });
  };

  /** Content rules on the provider request, built and ready to send. Returns the request to send. */
  const guardRequest = async <T extends { provider: LLMProviderConfig }>(admitted: Admitted, kind: "chat" | "embedding", stream: boolean, providerRequest: T): Promise<{ request: T; outcome: RecordedGuardOutcome }> => {
    if (!admitted.guard) return { request: providerRequest, outcome: "none" };
    const verdict = await checkAiGatewayRequest(admitted.guard, providerRequest);
    if (verdict.action === "block") {
      await auditGuardBlock(admitted, "prompt", verdict);
      await record(admitted, { kind, stream, status: "blocked_prompt", httpStatus: 400, guardOutcome: "block", errorCode: "content_filter" });
      throw aiGatewayErrors.promptBlocked(deps.redact(verdict.reason));
    }
    return verdict.action === "rewrite" ? { request: verdict.content, outcome: "rewrite" } : { request: providerRequest, outcome: "allow" };
  };

  // ---------------------------------------------------------------------------
  // Chat completions
  // ---------------------------------------------------------------------------

  const chatCompletions = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticate(request);
    const parsed = openAiChatCompletionRequestSchema.safeParse(parseBody(request));
    if (!parsed.success) throw zodError(parsed.error);
    const body = parsed.data;
    const wantsStream = body.stream === true;
    const admitted = await admit(request, reply, auth, body.model, "chat", wantsStream ? "stream" : "generate");
    try {
      const support = providerCallOptionSupport(admitted.route.providerId);
      const adapter = deps.providerRegistry.tryGet(admitted.route.providerId);
      if (!adapter) {
        app.log.warn({ alias: admitted.route.alias, providerId: admitted.route.providerId }, "AI gateway route names a provider that is not registered");
        throw aiGatewayErrors.upstream();
      }
      const includeUsage = wantsStream && body.stream_options?.include_usage === true;
      // Ask an OpenAI-family upstream for stream usage unless the route says its server cannot send it.
      const streamUsage = wantsStream && support.streamUsage && admitted.route.extra.streamUsage !== false;
      const mapped = toChatMessages(body.messages);
      const { options, temperature, maxTokens } = toCallOptions(body, admitted.route, { hasImages: mapped.hasImages, streamUsage });
      const provider = providerConfig(admitted.route, { ...(temperature !== undefined ? { temperature } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) });
      const tools = toToolDefinitions(body);
      const { request: callRequest, outcome: promptOutcome } = await guardRequest(admitted, "chat", wantsStream, { provider, messages: mapped.messages, ...(tools ? { tools } : {}), options });
      const context = executionContext(admitted);
      const base = { id: `chatcmpl-${admitted.requestId.slice(5)}`, created: Math.floor(admitted.startedAt / 1000), model: admitted.route.alias };
      const streamsForReal = wantsStream && support.streaming && typeof adapter.generateStream === "function" && admitted.outputMode !== "buffered";
      const inputTokens = () => estimateRequestTokens(callRequest);

      if (!streamsForReal) {
        // One answer: a non-stream request, a provider without streaming, or set of rule sets that may rewrite the answer.
        let answer;
        try {
          answer = await adapter.generate(callRequest, context);
        } catch (error) {
          if (admitted.abort.signal.aborted) {
            // Nothing of the answer was read, however much of it the provider produced before the call stopped.
            const estimate = () => ({ input: inputTokens(), output: unseenOutputTokens({ quietMs: Date.now() - admitted.startedAt, seenTokens: 0, maxTokens: callRequest.provider.maxTokens }) });
            await record(admitted, { kind: "chat", stream: wantsStream, status: "client_closed", httpStatus: 499, estimate, guardOutcome: promptOutcome });
            return reply;
          }
          const failure = upstreamFailure(admitted, error);
          await record(admitted, { kind: "chat", stream: wantsStream, status: "upstream_error", httpStatus: failure.status, ...failedCallCharge(error, inputTokens), guardOutcome: promptOutcome, errorCode: failure.code });
          throw failure;
        }
        let content = answer.content ?? "";
        let toolCalls = (answer.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name, arguments: argumentsText(call.arguments) }));
        const received = { content, toolCalls };
        const estimate = () => ({ input: inputTokens(), output: estimateAnswerTokens(received.content, received.toolCalls) });
        let finishReason: LLMFinishReason = answer.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
        let guardOutcome: RecordedGuardOutcome = promptOutcome;
        let status: AiGatewayRequestStatus = "ok";
        if (admitted.guard && admitted.outputMode !== "none") {
          let verdict;
          try {
            verdict = await checkAiGatewayAnswer(admitted.guard, { content, toolCalls });
          } catch (error) {
            // The provider was paid for: the row is written, and the answer stays unsent.
            await record(admitted, { kind: "chat", stream: wantsStream, status: "error", httpStatus: 500, ...(answer.usage ? { usage: answer.usage } : {}), estimate, guardOutcome, errorCode: "internal_error" });
            throw error;
          }
          if (verdict.action === "block") {
            await auditGuardBlock(admitted, "final_output", verdict);
            content = "";
            toolCalls = [];
            finishReason = "content_filter";
            guardOutcome = "block";
            status = "blocked_output";
          } else if (verdict.action === "rewrite") {
            ({ content, toolCalls } = verdict.content);
            guardOutcome = "rewrite";
          } else if (guardOutcome === "none") {
            guardOutcome = "allow";
          }
        }
        await record(admitted, { kind: "chat", stream: wantsStream, status, httpStatus: 200, finishReason, ...(answer.usage ? { usage: answer.usage } : {}), estimate, guardOutcome });
        if (!wantsStream) {
          return reply.code(200).send(chatCompletionBody({ ...base, content, toolCalls, finishReason, usage: answer.usage }));
        }
        const writer = new OpenAiSseWriter(request, reply, deps.config.SSE_HEARTBEAT_INTERVAL_MS);
        writer.data(chatChunk(base, { role: "assistant", content: "", refusal: null }));
        if (content) writer.data(chatChunk(base, { content }));
        if (toolCalls.length > 0) {
          writer.data(chatChunk(base, { tool_calls: openAiToolCalls(toolCalls).map((call, index) => ({ index, ...call })) }));
        }
        writer.data(chatChunk(base, {}, finishReason));
        if (includeUsage && reportedUsage(answer.usage)) writer.data(usageChunk(base, answer.usage));
        if (status === "blocked_output") writer.data(outputBlockedEvent());
        writer.end();
        return reply;
      }

      return await streamChat(request, reply, admitted, { adapter, callRequest, context, base, includeUsage, promptOutcome, inputTokens });
    } finally {
      admitted.release();
    }
  };

  const outputBlockedEvent = () => ({
    error: { message: "The rest of the answer was withheld by content rules.", type: "invalid_request_error", code: "content_filter", param: null }
  });

  const streamChat = async (
    request: FastifyRequest,
    reply: FastifyReply,
    admitted: Admitted,
    input: {
      adapter: NonNullable<ReturnType<ProviderRegistry["tryGet"]>>;
      callRequest: Parameters<NonNullable<ReturnType<ProviderRegistry["tryGet"]>>["generate"]>[0];
      context: ProviderExecutionContext;
      base: { id: string; created: number; model: string };
      includeUsage: boolean;
      promptOutcome: RecordedGuardOutcome;
      inputTokens: () => number;
    }
  ) => {
    const { base } = input;
    const writer = new OpenAiSseWriter(request, reply, deps.config.SSE_HEARTBEAT_INTERVAL_MS);
    const guarded = admitted.guard !== null && admitted.outputMode === "chunked";
    const collector = new ToolCallCollector();
    let sentText = "";
    let pendingText = "";
    /** How much of the end of `pendingText` no check has seen yet. */
    let uncheckedChars = 0;
    let finishReason: LLMFinishReason | null = null;
    let usage: LLMUsage | undefined;
    let cut: { reason: string; categories: string[]; profiles: unknown[] } | null = null;
    let guardOutcome: RecordedGuardOutcome = input.promptOutcome === "none" && guarded ? "allow" : input.promptOutcome;

    const opening = () => {
      if (!writer.isStarted) writer.data(chatChunk(base, { role: "assistant", content: "", refusal: null }));
    };
    const sendText = (length: number) => {
      if (length <= 0) return;
      const text = pendingText.slice(0, length);
      opening();
      writer.data(chatChunk(base, { content: text }));
      sentText += text;
      pendingText = pendingText.slice(length);
    };
    /** A boundary check of the text so far (records nothing). False when it blocks: the stream is cut. */
    const passes = async (): Promise<boolean> => {
      const verdict = await checkAiGatewayAnswer(admitted.guard!, { content: sentText + pendingText, toolCalls: [] }, false);
      // A rewrite cannot be applied to a streamed answer: it stops the stream like a block (buffered mode avoids it).
      if (verdict.action === "allow") return true;
      cut = verdict.action === "block" ? verdict : { reason: "Blocked by content rules: the answer would have been rewritten", categories: [], profiles: [] };
      return false;
    };

    /** When output last arrived: how long the provider may have been producing what the gateway never read. */
    let lastOutputAt = admitted.startedAt;
    /** What to charge if usage is missing. `stoppedEarly`: the gateway stopped reading before the provider finished. */
    const spend = (stoppedEarly: boolean) => (): UsageEstimate => {
      const seenTokens = estimateAnswerTokens(sentText + pendingText, collector.calls);
      const unseen = stoppedEarly ? unseenOutputTokens({ quietMs: Date.now() - lastOutputAt, seenTokens, maxTokens: input.callRequest.provider.maxTokens }) : 0;
      return { input: input.inputTokens(), output: seenTokens + unseen };
    };

    let upstreamError: unknown = null;
    let checkFailure: unknown = null;
    try {
      const stream = input.adapter.generateStream!(input.callRequest, input.context);
      for await (const chunk of stream) {
        if (writer.closed) break;
        if (chunk.type === "text_delta" || chunk.type === "tool_call_delta") lastOutputAt = Date.now();
        if (chunk.type === "text_delta") {
          if (!guarded) {
            opening();
            writer.data(chatChunk(base, { content: chunk.textDelta }));
            sentText += chunk.textDelta;
            continue;
          }
          pendingText += chunk.textDelta;
          uncheckedChars += chunk.textDelta.length;
          if (streamCheckDue(pendingText.slice(-uncheckedChars), deps.streamCheck)) {
            let passed: boolean;
            try {
              passed = await passes();
            } catch (error) {
              // The check failed, not the provider: kept apart from `upstreamError`, which blames the provider.
              checkFailure = error;
              break;
            }
            if (!passed) break;
            uncheckedChars = 0;
            // All of it passed, but its end may be the start of a match: that part waits for the text after it.
            sendText(streamReleaseLength(pendingText, deps.streamCheck?.holdChars));
          }
        } else if (chunk.type === "tool_call_delta") {
          const index = collector.add(chunk);
          if (guarded) continue;
          opening();
          writer.data(
            chatChunk(base, {
              tool_calls: [
                {
                  index,
                  ...(chunk.toolCallId ? { id: chunk.toolCallId, type: "function" } : {}),
                  function: { ...(chunk.name ? { name: chunk.name } : {}), ...(chunk.argumentsDelta !== undefined ? { arguments: chunk.argumentsDelta } : {}) }
                }
              ]
            })
          );
        } else if (chunk.type === "finish") {
          finishReason = chunk.reason;
        } else if (chunk.type === "usage") {
          usage = chunk.usage;
        }
      }
    } catch (error) {
      upstreamError = error;
    }

    const providerFinished = finishReason !== null;
    if (admitted.abort.signal.aborted || (writer.isStarted && writer.closed)) {
      await record(admitted, { kind: "chat", stream: true, status: "client_closed", httpStatus: 499, finishReason, ...(usage ? { usage } : {}), estimate: spend(!providerFinished), guardOutcome });
      return reply;
    }
    if (checkFailure) {
      // A boundary check that could not run: the provider was paid for and was still producing. What was held stays unsent.
      await record(admitted, { kind: "chat", stream: true, status: "error", httpStatus: writer.isStarted ? 200 : 500, finishReason, ...(usage ? { usage } : {}), estimate: spend(!providerFinished), guardOutcome, errorCode: "internal_error" });
      if (!writer.isStarted) throw checkFailure;
      app.log.error({ err: deps.redact(checkFailure instanceof Error ? checkFailure.message : String(checkFailure)), requestId: admitted.requestId }, "AI gateway could not check a streamed answer");
      writer.data(aiGatewayErrors.internal().body());
      writer.end();
      return reply;
    }
    if (upstreamError) {
      const failure = upstreamFailure(admitted, upstreamError);
      // What arrived is known; a stream the provider ended itself left nothing in flight.
      const charge = isModelNotAllowedError(upstreamError) ? {} : { estimate: spend(false) };
      await record(admitted, { kind: "chat", stream: true, status: "upstream_error", httpStatus: writer.isStarted ? 200 : failure.status, finishReason, ...(usage ? { usage } : {}), ...charge, guardOutcome, errorCode: failure.code });
      if (!writer.isStarted) throw failure;
      // Mid-stream: an OpenAI-style error event, then the end of the stream.
      writer.data(aiGatewayErrors.upstreamInterrupted().body());
      writer.end();
      return reply;
    }

    const toolCalls = collector.complete();
    // A cut breaks out of the read: the provider was still producing.
    const estimate = spend(cut !== null && !providerFinished);
    if (guarded) {
      // The audit check: the whole answer (also after a cut), recorded.
      let verdict;
      try {
        verdict = await checkAiGatewayAnswer(admitted.guard!, { content: sentText + pendingText, toolCalls });
      } catch (error) {
        // The provider was paid for: the row is written, and what was held back stays unsent.
        await record(admitted, { kind: "chat", stream: true, status: "error", httpStatus: writer.isStarted ? 200 : 500, finishReason, ...(usage ? { usage } : {}), estimate, guardOutcome, errorCode: "internal_error" });
        if (!writer.isStarted) throw error;
        app.log.error({ err: deps.redact(error instanceof Error ? error.message : String(error)), requestId: admitted.requestId }, "AI gateway could not finish checking a streamed answer");
        writer.data(aiGatewayErrors.internal().body());
        writer.end();
        return reply;
      }
      if (!cut && verdict.action !== "allow") {
        cut = verdict.action === "block" ? verdict : { reason: "Blocked by content rules: the answer would have been rewritten", categories: [], profiles: [] };
      }
      if (!cut) {
        sendText(pendingText.length);
        if (toolCalls.length > 0) {
          opening();
          writer.data(chatChunk(base, { tool_calls: openAiToolCalls(toolCalls).map((call, index) => ({ index, ...call })) }));
        }
      }
    }
    let status: AiGatewayRequestStatus = "ok";
    if (cut) {
      const blocked = cut as { reason: string; categories: string[]; profiles: unknown[] };
      await auditGuardBlock(admitted, "final_output", blocked);
      finishReason = "content_filter";
      guardOutcome = "block";
      status = "blocked_output";
    }
    const finish: LLMFinishReason = finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
    await record(admitted, { kind: "chat", stream: true, status, httpStatus: 200, finishReason: finish, ...(usage ? { usage } : {}), estimate, guardOutcome });
    opening();
    writer.data(chatChunk(base, {}, finish));
    if (input.includeUsage && reportedUsage(usage)) writer.data(usageChunk(base, usage));
    if (cut) writer.data(outputBlockedEvent());
    writer.end();
    return reply;
  };

  // ---------------------------------------------------------------------------
  // Embeddings
  // ---------------------------------------------------------------------------

  const embeddings = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticate(request);
    const parsed = openAiEmbeddingsRequestSchema.safeParse(parseBody(request));
    if (!parsed.success) throw zodError(parsed.error);
    const body = parsed.data;
    const rawInput = body.input;
    if (Array.isArray(rawInput) && rawInput.some((entry) => typeof entry !== "string")) {
      throw aiGatewayErrors.invalidRequest("Token arrays are not supported; send the input as text.", "input");
    }
    const inputs = typeof rawInput === "string" ? [rawInput] : (rawInput as string[]);
    if (inputs.some((text) => text.length === 0)) throw aiGatewayErrors.invalidRequest("Inputs must not be empty strings.", "input");
    const admitted = await admit(request, reply, auth, body.model, "embedding", "embed");
    try {
      const adapter = deps.embeddingRegistry.tryGet(admitted.route.providerId);
      if (!adapter) {
        app.log.warn({ alias: admitted.route.alias, providerId: admitted.route.providerId }, "AI gateway embedding route names a provider without embeddings");
        throw aiGatewayErrors.upstream();
      }
      const { request: embedRequest, outcome: guardOutcome } = await guardRequest(admitted, "embedding", false, {
        provider: providerConfig(admitted.route),
        input: inputs,
        ...(body.dimensions !== undefined ? { dimensions: body.dimensions } : {}),
        ...(body.user ? { user: body.user } : {})
      });
      const inputTokens = () => estimateRequestTokens(embedRequest);
      const estimate = () => ({ input: inputTokens(), output: 0 });
      let answer;
      try {
        answer = await adapter.embed(embedRequest, executionContext(admitted));
      } catch (error) {
        if (admitted.abort.signal.aborted) {
          await record(admitted, { kind: "embedding", stream: false, status: "client_closed", httpStatus: 499, estimate, guardOutcome });
          return reply;
        }
        const failure = upstreamFailure(admitted, error);
        await record(admitted, { kind: "embedding", stream: false, status: "upstream_error", httpStatus: failure.status, ...failedCallCharge(error, inputTokens), guardOutcome, errorCode: failure.code });
        throw failure;
      }
      const usage: LLMUsage = {
        inputTokens: answer.usage?.inputTokens ?? answer.usage?.totalTokens ?? 0,
        outputTokens: 0,
        totalTokens: answer.usage?.totalTokens ?? answer.usage?.inputTokens ?? 0
      };
      await record(admitted, { kind: "embedding", stream: false, status: "ok", httpStatus: 200, usage, estimate, guardOutcome });
      const base64 = body.encoding_format === "base64";
      return reply.code(200).send({
        object: "list",
        data: answer.embeddings.map((vector, index) => ({ object: "embedding", index, embedding: base64 ? base64Embedding(vector) : vector })),
        model: admitted.route.alias,
        usage: { prompt_tokens: usage.inputTokens ?? 0, total_tokens: usage.totalTokens ?? 0 }
      });
    } finally {
      admitted.release();
    }
  };

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  const modelView = (route: AiGatewayRoute) => ({ id: route.alias, object: "model", created: Math.floor(new Date(route.createdAt).getTime() / 1000) || 0, owned_by: "l2m" });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  const handle = (fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(request, reply);
    } catch (error) {
      if (reply.sent || reply.raw.headersSent) {
        if (!(error instanceof AiGatewayHttpError)) app.log.error({ err: deps.redact(error instanceof Error ? error.message : String(error)) }, "AI gateway request failed after the response started");
        if (!reply.raw.writableEnded) reply.raw.end();
        return reply;
      }
      if (error instanceof AiGatewayHttpError) return sendError(reply, error);
      app.log.error({ err: deps.redact(error instanceof Error ? error.message : String(error)), requestId: request.id }, "AI gateway request failed");
      return sendError(reply, aiGatewayErrors.internal());
    }
  };

  app.register(async (scope) => {
    // Parse JSON ourselves so a malformed body gets an OpenAI-style error.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
    scope.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
      const type = status >= 500 ? "server_error" : "invalid_request_error";
      const message = status === 413 ? "The request body is too large." : status === 415 ? "Send the body as application/json." : status >= 500 ? "The gateway could not complete the request." : error.message;
      if (status >= 500) app.log.error({ err: deps.redact(error.message), requestId: request.id }, "AI gateway request failed");
      return sendError(reply, new AiGatewayHttpError(status, message, type, status === 413 ? "request_too_large" : null));
    });

    scope.get(
      "/v1/models",
      handle(async (request) => {
        const auth = await authenticate(request);
        const routes = await store.listAiGatewayRoutesForClient(auth.client.id);
        return { object: "list", data: routes.map(({ route }) => modelView(route)) };
      })
    );
    scope.get<{ Params: { "*": string } }>(
      "/v1/models/*",
      handle(async (request) => {
        const auth = await authenticate(request);
        const alias = (request.params as { "*": string })["*"];
        const resolved = await store.resolveAiGatewayRoute(auth.client.id, alias);
        if (!resolved) throw aiGatewayErrors.modelNotFound(alias);
        return modelView(resolved.route);
      })
    );
    scope.post("/v1/chat/completions", handle(chatCompletions));
    scope.post("/v1/embeddings", handle(embeddings));
    // A route and not a not-found handler: that would answer for every unknown path of the whole app. OPTIONS stays with CORS.
    scope.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      url: "/v1/*",
      handler: async (_request, reply) => sendError(reply, aiGatewayErrors.notFound())
    });
  }, { prefix: "" });

}
