/**
 * The execution routes: start a run, stream one, and the run history (list, read, retry, replay, cancel).
 *
 *   POST /api/workflows/:id/execute          run the workflow and answer with its result
 *   POST /api/workflows/:id/execute/stream   run it and stream its events (SSE)
 *   GET  /api/executions                     the run history the user can read
 *   GET  /api/executions/:id                 one run
 *   POST /api/executions/:id/retry           run a failed or canceled run again
 *   POST /api/executions/:id/replay          run it again with its MCP calls answered from its cassette
 *   POST /api/executions/:id/cancel          stop a running or waiting run
 *
 * The run machinery (running, progress tracking, history writes) stays in app.ts; the routes get it through
 * ExecutionRoutesDeps.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  workflowExecuteRequestSchema,
  type DataLabels,
  type McpReplayMode,
  type MCPServerConfig,
  type ReleaseChannel,
  type Workflow,
  type WorkflowExecutionResult
} from "@ai-orchestrator/shared";
import type { MCPRegistry } from "@ai-orchestrator/mcp-sdk";
import type { AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { elicitationVisibleTo, type RunAccess } from "./run-access.js";
import type { RunWorkflowExecutionInput, WorkflowExecutionEventHooks } from "./run-types.js";
import {
  asRecord,
  isExecutionTimeoutAbort,
  normalizeExecutionTimeoutMs,
  normalizeIsoDateFilter,
  normalizeSessionId,
  retryAfterSeconds
} from "./run-helpers.js";
import { startSseHeartbeat } from "./sse-heartbeat.js";
import { DISPATCH_SPEC_VERSION, type RunDispatcher } from "./services/run-dispatch.js";
import { onceEachElicitationEvent, type RunEventName, type RunRelay } from "./services/run-event-relay.js";
import { followExecution } from "./services/execution-follow.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { ApprovalService } from "./services/approval-service.js";
import type { BudgetService } from "./services/budget-service.js";
import { clusterCancelReason } from "./services/cluster-signals.js";
import type { McpCassetteRunPlan, McpCassetteService } from "./services/mcp-cassette-service.js";
import type { McpElicitationService } from "./services/mcp-elicitation-service.js";
import type { CaptureSource } from "./services/replay-capture-service.js";
import type { ReleaseService } from "./services/release-service.js";

type WorkflowExecutePayload = z.infer<typeof workflowExecuteRequestSchema>;

export interface ExecutionRoutesDeps {
  app: FastifyInstance;
  store: Store;
  config: AppConfig;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  runAccess: RunAccess;
  denyRunAccess: (reply: FastifyReply, denial: { status: number; error: string }) => { error: string };
  /** The channel `/execute` runs on (an API key: production, unless it asks for the draft). */
  executeChannelFor: (
    request: FastifyRequest,
    user: SafeUser,
    workflowId: string
  ) => Promise<{ channel: ReleaseChannel } | { ok: false; status: 400 | 403 | 404; error: string }>;
  productionWorkflow: (workflowId: string) => Promise<Workflow | null>;
  productionMissing: (reply: FastifyReply, workflowId: string) => Promise<{ error: string }>;
  releaseService: Pick<ReleaseService, "productionRefusal">;
  budgetService: Pick<BudgetService, "checkExecution">;
  prepareWorkflowExecutionPayload: (
    payload: WorkflowExecutePayload,
    reply: FastifyReply,
    user: SafeUser
  ) => Promise<{ payload: WorkflowExecutePayload; nodeOutputs: Record<string, unknown>; requestInput: Record<string, unknown> } | null>;
  auditRunAction: (
    request: { ip?: string; headers: Record<string, unknown> },
    user: SafeUser,
    eventType: "execution.started" | "execution.retried" | "execution.replayed" | "execution.cancel_requested",
    run: { executionId: string; workflowId: string; projectId?: string | null },
    metadata?: Record<string, unknown>
  ) => Promise<void>;
  mcpCassetteService: Pick<McpCassetteService, "planReplay">;
  mcpRegistry: MCPRegistry;
  mcpElicitationService: Pick<McpElicitationService, "subscribe" | "get">;
  resolveRegisteredMcpServer: (registryServerId: string, actor?: SafeUser | null) => Promise<MCPServerConfig>;
  replayRunInputFor: (
    triggerType: string | null,
    stored: Record<string, unknown>
  ) => Pick<RunWorkflowExecutionInput, "directInput" | "webhookPayload" | "variables" | "systemPrompt" | "userPrompt" | "sessionId" | "usePinnedData">;
  historyInputLabels: (source: { triggerType: string | null; nodeResults: unknown }, workflow: Workflow) => DataLabels;
  /** Runs executing in this process, by execution id. */
  activeExecutions: Map<string, { controller: AbortController; workflowId: string }>;
  approvalService: Pick<ApprovalService, "cancelForExecution" | "auditCanceledRequests">;
  /** Phase 13.1 — Postgres with HA_ENABLED=true. */
  clusterMode: boolean;
  /** Publishes a control message on the cluster bus without failing the caller. */
  announce: (message: { t: string; [key: string]: unknown }) => void;
  /** Phase 13.1 — starts a run inline or on a queue worker (EXECUTION_DISPATCH); see services/run-dispatch.ts. */
  runDispatcher: Pick<RunDispatcher, "run">;
  /** The queue pool a workflow's dispatched runs go to. */
  dispatchPoolOf: (workflow: Workflow) => string;
  /**
   * Phase 13.1 — follows a run from its events (this process's when it executes here, else the cluster bus) and ends
   * from the database (services/run-event-relay.ts). `waitMs` is how long a follower waits at most.
   */
  openExecutionRelay: (executionId: string, onEvent: (name: RunEventName, payload: Record<string, unknown>) => void) => Promise<RunRelay>;
  executionRelayWaitMs: number;
}

export function registerExecutionRoutes(deps: ExecutionRoutesDeps): void {
  const {
    app,
    store,
    config,
    requireRole,
    runAccess,
    denyRunAccess,
    executeChannelFor,
    productionWorkflow,
    productionMissing,
    releaseService,
    budgetService,
    prepareWorkflowExecutionPayload,
    auditRunAction,
    mcpCassetteService,
    mcpRegistry,
    mcpElicitationService,
    resolveRegisteredMcpServer,
    replayRunInputFor,
    historyInputLabels,
    activeExecutions,
    approvalService,
    clusterMode,
    announce,
    runDispatcher,
    dispatchPoolOf,
    openExecutionRelay,
    executionRelayWaitMs
  } = deps;

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/execute", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const access = await runAccess.workflow(user, request.params.id, "workflow:execute");
    if (!access.ok) return denyRunAccess(reply, access);
    const executeChannel = await executeChannelFor(request, user, access.workflow.id);
    // Phase 15.6 — an API-key run on the production channel may be captured; it stays a `manual` run everywhere else.
    const executeTrigger = "manual";
    const captureSource: CaptureSource | undefined = "channel" in executeChannel && executeChannel.channel === "production" ? "api_key" : undefined;
    if ("error" in executeChannel) return denyRunAccess(reply, executeChannel);
    const workflow = executeChannel.channel === "production" ? await productionWorkflow(access.workflow.id) : access.workflow;
    if (!workflow) {
      reply.code(409);
      return { error: await releaseService.productionRefusal(access.workflow.id) ?? "Workflow not found" };
    }

    // Phase 8.3 — pre-execution budget check. Block-action budgets reject
    // here (HTTP 402); warn-action budgets only fire post-execution.
    const budgetCheck = await budgetService.checkExecution({
      workflowId: workflow.id,
      projectId: workflow.projectId ?? null,
      userEmail: user.email,
      userId: user.id
    });
    if (!budgetCheck.allowed && budgetCheck.blocked) {
      reply.code(402);
      reply.header("retry-after", retryAfterSeconds(budgetCheck.blocked.budget.period));
      return {
        error: "budget_exceeded",
        message: `Budget "${budgetCheck.blocked.budget.name}" exceeded for the current ${budgetCheck.blocked.budget.period}.`,
        budgetId: budgetCheck.blocked.budget.id,
        currentUsage: budgetCheck.blocked.current,
        limit: budgetCheck.blocked.limit,
        periodStart: budgetCheck.blocked.periodStart
      };
    }
    if (budgetCheck.approachingLimit.length > 0) {
      reply.header(
        "x-budget-warning",
        budgetCheck.approachingLimit
          .map((a) => `${a.budget.name}=${Math.round(a.pct * 100)}%`)
          .join(",")
      );
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }
    const prepared = await prepareWorkflowExecutionPayload(parsed.data, reply, user);
    if (!prepared) {
      return { error: "Source execution not found" };
    }
    const executionPayload = prepared.payload;

    const executionId = crypto.randomUUID();
    await auditRunAction(request, user, "execution.started", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { triggerType: executeTrigger });
    // Phase 13.1 — inline (default) or on a worker (EXECUTION_DISPATCH=queue); the answer is the same either way.
    const result = await runDispatcher.run({
      v: DISPATCH_SPEC_VERSION,
      run: {
      // Phase 15.4: API-key callers run the published version; the editor runs the draft.
      channel: executeChannel.channel,
      policyActor: user,
      workflow,
      startNodeId: executionPayload.startNodeId,
      runMode: executionPayload.runMode,
      usePinnedData: executionPayload.usePinnedData,
      pinnedData: executionPayload.pinnedData,
      nodeOutputs: prepared.nodeOutputs,
      directInput: executionPayload.input,
      variables: executionPayload.variables,
      systemPrompt: executionPayload.system_prompt,
      userPrompt: executionPayload.user_prompt,
      sessionId: normalizeSessionId(executionPayload.sessionId, executionPayload.session_id),
      executionTimeoutMs: normalizeExecutionTimeoutMs(
        executionPayload.executionTimeoutMs,
        executionPayload.execution_timeout_ms,
        config.WORKFLOW_EXECUTION_TIMEOUT_MS
      ),
      customData: executionPayload.customData,
      executionId,
      triggerType: executeTrigger,
      triggeredBy: user.email,
      captureSource,
      captureInputOrigin: captureSource ? "user" : undefined
      },
      progress: { requestInput: prepared.requestInput, customData: executionPayload.customData },
      history: { requestInput: prepared.requestInput, customData: executionPayload.customData },
      // Phase 10.8 — "Record MCP calls": every MCP call of the run goes into a cassette.
      ...(parsed.data.record ? { cassette: { kind: "record" as const, source: "manual" as const, createdBy: user.email } } : {})
    }, { pool: dispatchPoolOf(workflow) });

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

    const access = await runAccess.workflow(user, request.params.id, "workflow:execute");
    if (!access.ok) return denyRunAccess(reply, access);
    const executeChannel = await executeChannelFor(request, user, access.workflow.id);
    // Phase 15.6 — an API-key run on the production channel may be captured; it stays a `manual_stream` run everywhere else.
    const executeTrigger = "manual_stream";
    const captureSource: CaptureSource | undefined = "channel" in executeChannel && executeChannel.channel === "production" ? "api_key" : undefined;
    if ("error" in executeChannel) return denyRunAccess(reply, executeChannel);
    const workflow = executeChannel.channel === "production" ? await productionWorkflow(access.workflow.id) : access.workflow;
    if (!workflow) {
      reply.code(409);
      return { error: await releaseService.productionRefusal(access.workflow.id) ?? "Workflow not found" };
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }
    const prepared = await prepareWorkflowExecutionPayload(parsed.data, reply, user);
    if (!prepared) {
      return { error: "Source execution not found" };
    }
    const executionPayload = prepared.payload;

    const executionId = crypto.randomUUID();
    await auditRunAction(request, user, "execution.started", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { triggerType: executeTrigger });
    let streamClosed = false;
    let markClientGone: () => void = () => undefined;
    // A dispatched run stops being relayed when the client goes away; it goes on, as an inline run does.
    const clientGone = new Promise<void>((resolve) => {
      markClientGone = resolve;
    });
    request.raw.on("close", () => {
      streamClosed = true;
      markClientGone();
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
    const stopHeartbeat = startSseHeartbeat(reply.raw, config.SSE_HEARTBEAT_INTERVAL_MS, () => streamClosed);

    sendSseEvent("execution_started", {
      executionId,
      workflowId: workflow.id,
      triggerType: executeTrigger,
      startedAt: new Date().toISOString()
    });

    // Phase 10.5 — questions a server asks during the run reach the chat as they happen, each once: a dispatched run
    // this instance executes itself reports them here and through the relay.
    const sendElicitation = onceEachElicitationEvent((event) => sendSseEvent("mcp_elicitation", event));
    const unsubscribeElicitations = mcpElicitationService.subscribe(executionId, (event) => {
      sendElicitation({ ...event });
    });
    try {
      // Phase 13.1 — inline (default) or on a worker (EXECUTION_DISPATCH=queue), whose events are relayed here in order.
      const result = await runDispatcher.run({
        v: DISPATCH_SPEC_VERSION,
        run: {
        // Phase 15.4: API-key callers run the published version; the editor runs the draft.
        channel: executeChannel.channel,
        policyActor: user,
        workflow,
        startNodeId: executionPayload.startNodeId,
        runMode: executionPayload.runMode,
        usePinnedData: executionPayload.usePinnedData,
        pinnedData: executionPayload.pinnedData,
        nodeOutputs: prepared.nodeOutputs,
        directInput: executionPayload.input,
        variables: executionPayload.variables,
        systemPrompt: executionPayload.system_prompt,
        userPrompt: executionPayload.user_prompt,
        sessionId: normalizeSessionId(executionPayload.sessionId, executionPayload.session_id),
        executionTimeoutMs: normalizeExecutionTimeoutMs(
          executionPayload.executionTimeoutMs,
          executionPayload.execution_timeout_ms,
          config.WORKFLOW_EXECUTION_TIMEOUT_MS
        ),
        customData: executionPayload.customData,
        executionId,
        triggerType: executeTrigger,
        triggeredBy: user.email,
        captureSource,
        captureInputOrigin: captureSource ? "user" : undefined
        },
        progress: { requestInput: prepared.requestInput, customData: executionPayload.customData },
        history: { requestInput: prepared.requestInput, customData: executionPayload.customData },
        ...(parsed.data.record ? { cassette: { kind: "record" as const, source: "manual" as const, createdBy: user.email } } : {})
      }, {
        pool: dispatchPoolOf(workflow),
        passthrough: {
          onNodeStart: (event) => {
            sendSseEvent("node_start", event);
          },
          onNodeComplete: (event) => {
            sendSseEvent("node_complete", event);
          },
          onLLMDelta: (event) => {
            sendSseEvent("llm_delta", event);
          },
          onMcpProgress: (event) => {
            sendSseEvent("node_progress", event);
          },
          onNodeActivity: (event) => {
            sendSseEvent("node_activity", event);
          },
          // A dispatched run's questions arrive through the relay (an inline run's through the subscription above).
          onMcpElicitation: (event) => {
            sendElicitation({ ...event });
          }
        },
        closed: clientGone
      });

      sendSseEvent("result", result);
      if (result.status === "error") {
        sendSseEvent("error", { message: result.error ?? "Execution failed" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Execution failed";
      sendSseEvent("error", { message });
    } finally {
      stopHeartbeat();
      unsubscribeElicitations();
      if (!streamClosed) {
        reply.raw.end();
      }
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

    const history = await store.listExecutionHistory({
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
      status: typeof query.status === "string" && query.status.trim() ? query.status.trim() : undefined,
      workflowId: typeof query.workflowId === "string" && query.workflowId.trim() ? query.workflowId.trim() : undefined,
      // Only runs of workflows the user can read, filtered before paging so totals match.
      workflowIds: await runAccess.readableWorkflowIds(user) ?? undefined,
      triggerType:
        typeof query.triggerType === "string" && query.triggerType.trim() ? query.triggerType.trim() : undefined,
      startedFrom: normalizeIsoDateFilter(query.startedFrom),
      startedTo: normalizeIsoDateFilter(query.startedTo)
    });
    // Phase 10.8 — runs recorded with "Record MCP calls" carry a cassette badge.
    const badges = await store.mcpCassetteBadgesForExecutions(history.items.map((item) => item.id));
    // Phase 15.1 — runs saved as golden runs carry a golden badge.
    const golden = await store.replayGoldenBadgesForExecutions(history.items.map((item) => item.id));
    return {
      ...history,
      items: history.items.map((item) => {
        const badge = badges.get(item.id);
        const goldenBadge = golden.get(item.id);
        return { ...item, ...(badge ? { mcpCassette: badge } : {}), ...(goldenBadge ? { goldenRuns: goldenBadge } : {}) };
      })
    };
  });

  app.get<{ Params: { id: string } }>("/api/executions/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const access = await runAccess.run(user, await store.getExecutionHistory(request.params.id), "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);

    return access.run;
  });

  /**
   * Phase 13.1 — reattach: follow a run from any instance. An `execution` event with the run as stored, then its
   * events as they happen (node_start, node_complete, llm_delta, node_progress, node_activity, mcp_elicitation), then
   * `result`. A finished run answers with `execution` and `result` at once. The run is not affected by the stream.
   */
  app.get<{ Params: { id: string } }>("/api/executions/:id/events", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }
    const access = await runAccess.run(user, await store.getExecutionHistory(request.params.id), "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const executionId = access.run.id;

    let closed = false;
    const send = (event: string, payload: unknown) => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\n`);
      for (const line of JSON.stringify(payload ?? null).split("\n")) reply.raw.write(`data: ${line}\n`);
      reply.raw.write("\n");
    };
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();
    const stopHeartbeat = startSseHeartbeat(reply.raw, config.SSE_HEARTBEAT_INTERVAL_MS, () => closed);
    const follower = followExecution({
      open: async (onEvent) => await openExecutionRelay(executionId, onEvent),
      readExecution: async () => await store.getExecutionHistory(executionId),
      // The elicitation API's own rule: a reattach shows no request that API would hide from this user.
      elicitationVisible: async (elicitationId) => {
        const record = await mcpElicitationService.get(elicitationId);
        return record !== null && record.executionId === executionId && (await elicitationVisibleTo(runAccess, user, record));
      },
      send,
      waitMs: executionRelayWaitMs
    });
    const finish = () => {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      follower.close();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    request.raw.on("close", finish);
    await follower.done;
    finish();
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/retry", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const sourceAccess = await runAccess.run(user, await store.getExecutionHistory(request.params.id), "workflow:execute");
    if (!sourceAccess.ok) return denyRunAccess(reply, sourceAccess);
    const sourceExecution = sourceAccess.run;

    if (!["error", "partial", "canceled"].includes(sourceExecution.status)) {
      reply.code(409);
      return { error: "Only failed or canceled executions can be retried from history" };
    }

    // Phase 15.4 — a retry runs on the failed run's channel. A production run is retried as production runs now:
    // the version published today (never a superseded or rolled-back one, nor the draft once a version is
    // published), and not at all while a gated workflow is deactivated. An editor run retries the draft.
    // A run whose channel went unrecorded (older history, a record that failed to save, a run that fell out of
    // the in-flight bookkeeping) fails closed: on a gated workflow it retries as production, never the draft.
    const ranOn = await store.getExecutionRelease(sourceExecution.id);
    const retryChannel: ReleaseChannel = ranOn
      ? ranOn.channel
      : (await store.getReleaseGate(sourceExecution.workflowId))?.enabled
        ? "production"
        : "draft";
    const workflow = retryChannel === "production" ? await productionWorkflow(sourceExecution.workflowId) : await store.getWorkflow(sourceExecution.workflowId);
    if (!workflow) return await productionMissing(reply, sourceExecution.workflowId);

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid retry payload",
        details: parsed.error.issues
      };
    }

    const prepared = await prepareWorkflowExecutionPayload({
      ...parsed.data,
      sourceExecutionId: sourceExecution.id,
      usePinnedData: parsed.data.usePinnedData ?? true
    }, reply, user);
    if (!prepared) {
      return { error: "Source execution not found" };
    }

    const executionPayload = prepared.payload;
    const executionId = crypto.randomUUID();
    await auditRunAction(request, user, "execution.retried", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { sourceExecutionId: sourceExecution.id });
    const result = await runDispatcher.run({
      v: DISPATCH_SPEC_VERSION,
      run: {
      // Phase 15.4: the failed run's channel; a production retry records the version it runs now.
      channel: retryChannel,
      policyActor: user,
      workflow,
      startNodeId: executionPayload.startNodeId,
      runMode: executionPayload.runMode,
      usePinnedData: executionPayload.usePinnedData,
      pinnedData: executionPayload.pinnedData,
      nodeOutputs: prepared.nodeOutputs,
      directInput: executionPayload.input,
      variables: executionPayload.variables,
      systemPrompt: executionPayload.system_prompt,
      userPrompt: executionPayload.user_prompt,
      sessionId: normalizeSessionId(executionPayload.sessionId, executionPayload.session_id),
      executionTimeoutMs: normalizeExecutionTimeoutMs(
        executionPayload.executionTimeoutMs,
        executionPayload.execution_timeout_ms,
        config.WORKFLOW_EXECUTION_TIMEOUT_MS
      ),
      customData: executionPayload.customData,
      executionId,
      triggerType: "manual_retry",
      triggeredBy: user.email
      },
      progress: { requestInput: prepared.requestInput, customData: executionPayload.customData },
      history: { requestInput: prepared.requestInput, customData: executionPayload.customData }
    }, { pool: dispatchPoolOf(workflow) });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  // Phase 10.8 — run a past execution again with its MCP calls answered from its cassette.
  const executionReplaySchema = z.object({
    mode: z.enum(["strict", "lenient"]).optional(),
    cassetteId: z.string().trim().min(1).optional()
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/replay", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }
    const parsed = executionReplaySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid replay payload", details: parsed.error.issues };
    }
    const sourceAccess = await runAccess.run(user, await store.getExecutionHistory(request.params.id), "workflow:execute");
    if (!sourceAccess.ok) return denyRunAccess(reply, sourceAccess);
    const source = sourceAccess.run;
    const cassette = parsed.data.cassetteId ? await store.getMcpCassette(parsed.data.cassetteId) : await store.getMcpCassetteForExecution(source.id);
    if (!cassette) {
      reply.code(404);
      return { error: "No cassette was recorded for this execution. Run it with Record MCP calls turned on first." };
    }
    // An unreadable cassette reads as missing; a readable one must belong to
    // this workflow (a cassette with no workflow never does).
    if (parsed.data.cassetteId) {
      const cassetteAccess = await runAccess.run(user, { id: cassette.id, workflowId: cassette.workflowId ?? "" }, "workflow:read", "Cassette");
      if (!cassetteAccess.ok) return denyRunAccess(reply, cassetteAccess);
    }
    if (cassette.workflowId !== source.workflowId) {
      reply.code(409);
      return { error: "That cassette was recorded for a different workflow." };
    }
    const workflow = await store.getWorkflow(source.workflowId);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    const mode: McpReplayMode = parsed.data.mode ?? "strict";
    const mcpPlan = mcpCassetteService.planReplay(cassette, mode, mcpRegistry, resolveRegisteredMcpServer);
    const executionId = crypto.randomUUID();
    await auditRunAction(request, user, "execution.replayed", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { sourceExecutionId: source.id, cassetteId: cassette.id, mode });
    const storedInput = asRecord(source.input);
    const customData = {
      ...asRecord(source.customData),
      mcpReplay: { sourceExecutionId: source.id, cassetteId: cassette.id, mode }
    };
    const result = await runDispatcher.run({
      v: DISPATCH_SPEC_VERSION,
      run: {
      // Phase 15.4: not production traffic, so the draft (or the candidate given) runs.
      channel: "draft",
      ...replayRunInputFor(source.triggerType, storedInput),
      // Phase 16 — the source run's input origin, not the user replaying it.
      inputLabels: historyInputLabels(source, workflow),
      policyActor: user,
      workflow,
      customData,
      executionId,
      triggerType: "mcp_replay",
      triggeredBy: user.email
      },
      progress: { requestInput: storedInput, customData },
      history: { requestInput: storedInput, customData },
      // A worker plans the same replay from the cassette; inline uses the plan built above.
      cassette: { kind: "replay", cassetteId: cassette.id, mode, source: "replay", createdBy: user.email }
    }, { pool: dispatchPoolOf(workflow), local: { mcpPlan } });
    return { ...result, executionId };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/cancel", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator", "builder", "admin"]);
    if (!user) {
      return;
    }

    const access = await runAccess.run(user, await store.getExecutionHistory(request.params.id), "workflow:execute");
    if (!access.ok) return denyRunAccess(reply, access);
    const execution = access.run;

    const cancelable =
      execution.status === "running" ||
      execution.status === "waiting_approval" ||
      (execution.status === "partial" && !execution.completedAt);
    if (!cancelable) {
      reply.code(409);
      return { error: "Only running or waiting executions can be canceled" };
    }

    const reasonRecord = asRecord(request.body);
    const reason =
      typeof reasonRecord.reason === "string" && reasonRecord.reason.trim()
        ? reasonRecord.reason.trim()
        : `Execution canceled by ${user.email}`;
    const active = activeExecutions.get(request.params.id);
    // The run already hit its time limit and is ending; it is saved as a timeout error, not a cancel.
    if (active && isExecutionTimeoutAbort(active.controller.signal)) {
      reply.code(409);
      return { error: "Execution already timed out and is stopping" };
    }
    const waiting = execution.status === "waiting_approval";
    // A paused run belongs to whoever moves it first: the cancel takes the pending request (a decision that took it
    // already wins), then cancels the history and drops the paused state in one write that refuses once a
    // decision has claimed that state.
    // A waiting run that is active here is a decided run resuming in this process (a resume writes no progress, so
    // its history still reads waiting): it is stopped like a running run, whatever the decision was.
    const resumingHere = waiting && Boolean(active);
    if (waiting && (await approvalService.cancelForExecution(execution.id, reason, user)) === "decided" && !resumingHere) {
      reply.code(409);
      return { error: "The approval was already decided, so the run is resuming. It cannot be canceled while it waits any more." };
    }
    // Aborted before the write: the run's own final write is then skipped, so it cannot replace the canceled
    // record; a run that finished first makes the conditional write refuse (409).
    active?.controller.abort(reason);
    const completedAt = new Date().toISOString();
    const { outcome, canceledRequestIds } = await store.cancelExecution({
      id: request.params.id,
      onlyFrom: resumingHere ? ["waiting_approval", "running", "partial"] : waiting ? ["waiting_approval"] : ["running", "partial"],
      completedAt,
      error: reason,
      deletePausedState: waiting,
      cancelClaimed: resumingHere
    });
    if (outcome === "missing") {
      reply.code(404);
      return { error: "Execution not found" };
    }
    if (outcome === "decided") {
      reply.code(409);
      return { error: "The approval was already decided, so the run is resuming. It cannot be canceled while it waits any more." };
    }
    // The run this cancel aborted can record its own canceled ending (with its node results) before the write above
    // commits: the cancel took effect, so it is not refused.
    const recordedByRun = outcome === "not_cancelable" && Boolean(active) && (await store.getExecutionHistory(request.params.id))?.status === "canceled";
    if (outcome === "not_cancelable" && !recordedByRun) {
      reply.code(409);
      return { error: "Only running or waiting executions can be canceled" };
    }
    // Phase 13.1 — cluster mode: a run that is not executing here may be executing on another instance. The canceled
    // record is stored, so the instance running it stops it on this message, or at its next cancel check if the
    // message is lost.
    const abortSignalled = clusterMode && !active;
    // The reason is cut and cleaned for the bus; the run's stored record keeps the full one.
    if (abortSignalled) announce({ t: "cancel", id: request.params.id, reason: clusterCancelReason(reason) });

    await approvalService.auditCanceledRequests(canceledRequestIds, user);
    await auditRunAction(
      request,
      user,
      "execution.cancel_requested",
      { executionId: execution.id, workflowId: execution.workflowId, projectId: (await store.getWorkflow(execution.workflowId))?.projectId },
      { abortedActiveRun: Boolean(active), previousStatus: execution.status, ...(abortSignalled ? { abortSignalled } : {}) }
    );
    return {
      ok: true,
      id: request.params.id,
      status: "canceled",
      abortedActiveRun: Boolean(active),
      ...(abortSignalled ? { abortSignalled } : {}),
      completedAt
    };
  });
}
