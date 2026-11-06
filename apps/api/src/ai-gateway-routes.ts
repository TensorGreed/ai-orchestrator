/**
 * 12.6b — the OpenAI-compatible `/v1` AI gateway: `GET /v1/models`, `POST /v1/chat/completions` (JSON or SSE) and
 * `POST /v1/embeddings`, for applications outside L2M.
 *
 * Callers authenticate with an MCP gateway client token (A1) and name a route alias as `model` (A2). Admission order:
 * client token (and its certificate and address pins) -> route granted to the client -> rate limit (the client's own, else the route set's default) ->
 * budgets (the client's, the route set's project's, the deployment's) -> model allowlist -> Content rules on the prompt ->
 * provider -> Content rules on the answer -> usage row -> response. Errors use the OpenAI envelope (A9). Nothing answers but
 * 401/404 until an admin creates a route set and grants it to a client (A12): no route set means no route to find.
 *
 * Only metadata is recorded per request (A5): tokens, cost, latency, model, finish reason and the rule outcome, in
 * ai_gateway_requests, written before the response ends (A10) so budget checks on any replica see it.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  LLMProviderError,
  isModelNotAllowedError,
  providerCallOptionSupport,
  type EmbeddingProviderRegistry,
  type LLMStreamChunk,
  type ProviderExecutionContext,
  type ProviderRegistry
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
  /** Boundary sizes for streamed content rule checks (tests). */
  streamCheck?: { minChars?: number; maxChars?: number };
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

    // Rate limit: the client's own limit (one allowance across the MCP gateway and /v1), else the set's default.
    let release = () => undefined as void;
    const effective = effectiveGatewayRateLimit(client, { id: `ai:${routeSet.id}`, rateLimit: routeSet.rateLimit });
    if (effective) {
      const key = effective.source === "client" ? effective.key : `client:${client.id}:aiset:${routeSet.id}`;
      const decision = await limiter.acquire(key, effective.limit);
      if (!decision.ok) {
        await auditRefusal(client, routeSet, "ai_gateway.rate_limited", { alias: route.alias, reason: decision.reason, source: effective.source });
        throw aiGatewayErrors.rateLimited(decision.message, Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
      }
      release = decision.release;
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

  /** A provider failure as the caller sees it: never the upstream text (it can name hosts or echo keys). */
  const upstreamFailure = (admitted: Admitted, error: unknown): AiGatewayHttpError => {
    // The list changed after admission: the provider registry's own check refused the call, so nothing was sent.
    if (isModelNotAllowedError(error)) return aiGatewayErrors.modelNotAllowed(admitted.route.alias);
    const message = deps.redact(error instanceof Error ? error.message : String(error));
    app.log.warn({ requestId: admitted.requestId, alias: admitted.route.alias, providerId: admitted.route.providerId, err: message.slice(0, 500) }, "AI gateway provider call failed");
    if (error instanceof LLMProviderError && error.statusCode === 429) return aiGatewayErrors.upstreamRateLimited(30);
    return aiGatewayErrors.upstream(error instanceof LLMProviderError ? error.statusCode : undefined);
  };

  const record = async (
    admitted: Admitted,
    input: {
      kind: "chat" | "embedding";
      stream: boolean;
      status: AiGatewayRequestStatus;
      httpStatus: number;
      finishReason?: string | null;
      usage?: LLMUsage;
      guardOutcome: RecordedGuardOutcome;
      errorCode?: string | null;
    }
  ) => {
    const tokens = usageTokens(input.usage);
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
  const guardRequest = async <T extends { provider: LLMProviderConfig }>(admitted: Admitted, kind: "chat" | "embedding", providerRequest: T): Promise<{ request: T; outcome: RecordedGuardOutcome }> => {
    if (!admitted.guard) return { request: providerRequest, outcome: "none" };
    const verdict = await checkAiGatewayRequest(admitted.guard, providerRequest);
    if (verdict.action === "block") {
      await auditGuardBlock(admitted, "prompt", verdict);
      await record(admitted, { kind, stream: false, status: "blocked_prompt", httpStatus: 400, guardOutcome: "block", errorCode: "content_filter" });
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
      const { request: callRequest, outcome: promptOutcome } = await guardRequest(admitted, "chat", { provider, messages: mapped.messages, ...(tools ? { tools } : {}), options });
      const context = executionContext(admitted);
      const base = { id: `chatcmpl-${admitted.requestId.slice(5)}`, created: Math.floor(admitted.startedAt / 1000), model: admitted.route.alias };
      const streamsForReal = wantsStream && support.streaming && typeof adapter.generateStream === "function" && admitted.outputMode !== "buffered";

      if (!streamsForReal) {
        // One answer: a non-stream request, a provider without streaming, or set of rule sets that may rewrite the answer.
        let answer;
        try {
          answer = await adapter.generate(callRequest, context);
        } catch (error) {
          if (admitted.abort.signal.aborted) {
            await record(admitted, { kind: "chat", stream: wantsStream, status: "client_closed", httpStatus: 499, guardOutcome: promptOutcome });
            return reply;
          }
          const failure = upstreamFailure(admitted, error);
          await record(admitted, { kind: "chat", stream: wantsStream, status: "upstream_error", httpStatus: failure.status, guardOutcome: promptOutcome, errorCode: failure.code });
          throw failure;
        }
        let content = answer.content ?? "";
        let toolCalls = (answer.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name, arguments: argumentsText(call.arguments) }));
        let finishReason: LLMFinishReason = answer.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
        let guardOutcome: RecordedGuardOutcome = promptOutcome;
        let status: AiGatewayRequestStatus = "ok";
        if (admitted.guard && admitted.outputMode !== "none") {
          const verdict = await checkAiGatewayAnswer(admitted.guard, { content, toolCalls });
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
        await record(admitted, { kind: "chat", stream: wantsStream, status, httpStatus: 200, finishReason, ...(answer.usage ? { usage: answer.usage } : {}), guardOutcome });
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
        if (includeUsage) writer.data(usageChunk(base, answer.usage));
        if (status === "blocked_output") writer.data(outputBlockedEvent());
        writer.end();
        return reply;
      }

      return await streamChat(request, reply, admitted, { adapter, callRequest, context, base, includeUsage, promptOutcome });
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
    }
  ) => {
    const { base } = input;
    const writer = new OpenAiSseWriter(request, reply, deps.config.SSE_HEARTBEAT_INTERVAL_MS);
    const guarded = admitted.guard !== null && admitted.outputMode === "chunked";
    const collector = new ToolCallCollector();
    let sentText = "";
    let pendingText = "";
    let finishReason: LLMFinishReason | null = null;
    let usage: LLMUsage | undefined;
    let cut: { reason: string; categories: string[]; profiles: unknown[] } | null = null;
    let guardOutcome: RecordedGuardOutcome = input.promptOutcome === "none" && guarded ? "allow" : input.promptOutcome;

    const opening = () => {
      if (!writer.isStarted) writer.data(chatChunk(base, { role: "assistant", content: "", refusal: null }));
    };
    const flushText = () => {
      if (!pendingText) return;
      opening();
      writer.data(chatChunk(base, { content: pendingText }));
      sentText += pendingText;
      pendingText = "";
    };
    /** A boundary check of the text so far (records nothing). False when it blocks: the stream is cut. */
    const passes = async (): Promise<boolean> => {
      const verdict = await checkAiGatewayAnswer(admitted.guard!, { content: sentText + pendingText, toolCalls: [] }, false);
      // A rewrite cannot be applied to a streamed answer: it stops the stream like a block (buffered mode avoids it).
      if (verdict.action === "allow") return true;
      cut = verdict.action === "block" ? verdict : { reason: "Blocked by content rules: the answer would have been rewritten", categories: [], profiles: [] };
      return false;
    };

    let upstreamError: unknown = null;
    try {
      const stream = input.adapter.generateStream!(input.callRequest, input.context);
      for await (const chunk of stream) {
        if (writer.closed) break;
        if (chunk.type === "text_delta") {
          if (!guarded) {
            opening();
            writer.data(chatChunk(base, { content: chunk.textDelta }));
            sentText += chunk.textDelta;
            continue;
          }
          pendingText += chunk.textDelta;
          if (streamCheckDue(pendingText, deps.streamCheck)) {
            if (!(await passes())) break;
            flushText();
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

    if (admitted.abort.signal.aborted || (writer.isStarted && writer.closed)) {
      await record(admitted, { kind: "chat", stream: true, status: "client_closed", httpStatus: 499, finishReason, ...(usage ? { usage } : {}), guardOutcome });
      return reply;
    }
    if (upstreamError) {
      const failure = upstreamFailure(admitted, upstreamError);
      await record(admitted, { kind: "chat", stream: true, status: "upstream_error", httpStatus: writer.isStarted ? 200 : failure.status, finishReason, ...(usage ? { usage } : {}), guardOutcome, errorCode: failure.code });
      if (!writer.isStarted) throw failure;
      // Mid-stream: an OpenAI-style error event, then the end of the stream.
      writer.data(aiGatewayErrors.upstreamInterrupted().body());
      writer.end();
      return reply;
    }

    const toolCalls = collector.complete();
    if (guarded) {
      // The audit check: the whole answer (also after a cut), recorded.
      const verdict = await checkAiGatewayAnswer(admitted.guard!, { content: sentText + pendingText, toolCalls });
      if (!cut && verdict.action !== "allow") {
        cut = verdict.action === "block" ? verdict : { reason: "Blocked by content rules: the answer would have been rewritten", categories: [], profiles: [] };
      }
      if (!cut) {
        flushText();
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
    await record(admitted, { kind: "chat", stream: true, status, httpStatus: 200, finishReason: finish, ...(usage ? { usage } : {}), guardOutcome });
    opening();
    writer.data(chatChunk(base, {}, finish));
    if (input.includeUsage) writer.data(usageChunk(base, usage));
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
      const { request: embedRequest, outcome: guardOutcome } = await guardRequest(admitted, "embedding", {
        provider: providerConfig(admitted.route),
        input: inputs,
        ...(body.dimensions !== undefined ? { dimensions: body.dimensions } : {}),
        ...(body.user ? { user: body.user } : {})
      });
      let answer;
      try {
        answer = await adapter.embed(embedRequest, executionContext(admitted));
      } catch (error) {
        if (admitted.abort.signal.aborted) {
          await record(admitted, { kind: "embedding", stream: false, status: "client_closed", httpStatus: 499, guardOutcome });
          return reply;
        }
        const failure = upstreamFailure(admitted, error);
        await record(admitted, { kind: "embedding", stream: false, status: "upstream_error", httpStatus: failure.status, guardOutcome, errorCode: failure.code });
        throw failure;
      }
      const usage: LLMUsage = {
        inputTokens: answer.usage?.inputTokens ?? answer.usage?.totalTokens ?? 0,
        outputTokens: 0,
        totalTokens: answer.usage?.totalTokens ?? answer.usage?.inputTokens ?? 0
      };
      await record(admitted, { kind: "embedding", stream: false, status: "ok", httpStatus: 200, usage, guardOutcome });
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
      return sendError(reply, new AiGatewayHttpError(500, "The gateway could not complete the request.", "server_error", "internal_error"));
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
