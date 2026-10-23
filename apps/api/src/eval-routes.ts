/**
 * Evals (Phase 7.3, 9.5, 10.8) and replay jobs (Phase 15.2).
 *
 *   GET    /api/eval/datasets                       datasets and golden sets the user can read (viewer)
 *   POST   /api/eval/datasets                       create one; `workflowId` makes it a golden set (builder)
 *   DELETE /api/eval/datasets/:id                   (builder)
 *   GET    /api/eval/datasets/:id/fixtures          (viewer)
 *   POST   /api/eval/datasets/:id/fixtures          a hand-written case (builder)
 *   POST   /api/eval/datasets/:id/recordings        a golden run as a case of a golden set (builder)
 *   DELETE /api/eval/fixtures/:id                   (builder)
 *   POST   /api/eval/runs                           queue an eval run: 202; `?wait=true` waits and answers 200 as before 15.2 (builder)
 *   GET    /api/eval/runs                           (viewer)
 *   GET    /api/eval/runs/:id                       with its case results (viewer)
 *   POST   /api/eval/runs/:id/cancel                (builder)
 *   GET    /api/eval/runs/:id/events                server-sent progress until the run finishes (viewer)
 *   POST   /api/replay/runs                         queue a replay job over golden sets: 202 (builder)
 *   GET    /api/replay/runs                         replay jobs (viewer)
 *   GET    /api/replay/runs/:id                     one job with its case results (viewer)
 *   GET    /api/replay/runs/:id/results/:resultId   one case with its run diff (viewer)
 *   POST   /api/replay/runs/:id/cancel              (builder)
 *
 * Access follows the workflow: a golden set, and every run, belongs to a
 * workflow, and reading needs `workflow:read` on it, editing a set
 * `workflow:write`, starting or canceling a run `workflow:execute` (admins
 * always pass). A dataset without a workflow follows its project; one with
 * neither (made before projects scoped datasets) is visible to builders
 * and admins only. Something the user cannot read answers 404, as if it did
 * not exist; something they can read but not change answers 403. A judge
 * scorer's `secretRef` (on the request or on any case of the set) must name
 * a secret the starting user may use in the workflow's project; the judge
 * checks it again for every call.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  EVAL_RUN_FINISHED_STATUSES,
  evalScorerListSchema,
  goldenSetAddRecordingSchema,
  goldenSetCreateSchema,
  replayJobRequestSchema,
  type EvalRunView,
  type EvalScorerSpec
} from "@ai-orchestrator/shared";
import type { EvalDatasetRecord, SqliteStore } from "./db/database.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { EvalRunError, type EvalService } from "./services/eval-service.js";
import { startSseHeartbeat } from "./sse-heartbeat.js";

type WorkflowPermission = "workflow:read" | "workflow:write" | "workflow:execute";

export interface EvalRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  evals: EvalService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  canAccessWorkflow: (user: SafeUser, workflow: { id: string; projectId?: string }, permission: WorkflowPermission) => boolean;
  canInProject: (user: SafeUser, projectId: string, permission: WorkflowPermission) => boolean;
  /** Whether `user` may hand this secret to a judge running for a workflow in `projectId`. */
  canUseSecret: (user: SafeUser, secretId: string, projectId: string) => boolean;
  /** Whether the MCP cassette exists and the user may read it (eval runs that replay one). */
  cassetteAllowed: (user: SafeUser, cassetteId: string) => boolean;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
  sseHeartbeatMs: number;
}

const EVAL_RUN_ERROR_STATUS: Record<EvalRunError["code"], number> = { not_found: 404, invalid: 400, limit: 409 };

/** Phase 10.8 — eval runs can record their MCP calls, or replay them from cassettes. */
const evalMcpOptionsSchema = z.object({
  record: z.boolean().optional(),
  replay: z
    .object({
      cassetteId: z.string().trim().min(1).optional(),
      evalRunId: z.string().trim().min(1).optional(),
      mode: z.enum(["strict", "lenient"]).optional()
    })
    .refine((value) => Boolean(value.cassetteId) !== Boolean(value.evalRunId), {
      message: "replay needs exactly one of cassetteId or evalRunId"
    })
    .optional()
});

const fixtureCreateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  input: z.unknown().refine((value) => value !== undefined, { message: "input is required" }),
  expected: z.unknown().optional(),
  scorers: evalScorerListSchema.optional()
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}` : "invalid request";
}

function limitFrom(raw: string | undefined, fallback: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : fallback;
}

export function registerEvalRoutes(deps: EvalRoutesDeps): void {
  const { app, store, evals, requireRole } = deps;

  const workflowAllows = (user: SafeUser, workflowId: string, permission: WorkflowPermission): boolean => {
    if (user.role === "admin") return true;
    const workflow = store.getWorkflow(workflowId);
    return workflow ? deps.canAccessWorkflow(user, workflow, permission) : false;
  };

  const datasetAllows = (user: SafeUser, dataset: EvalDatasetRecord, permission: WorkflowPermission): boolean => {
    if (user.role === "admin") return true;
    if (dataset.workflowId) return workflowAllows(user, dataset.workflowId, permission);
    if (dataset.projectId) return deps.canInProject(user, dataset.projectId, permission);
    return user.role === "builder";
  };

  /** A run is the workflow's; when the workflow is gone, its first dataset decides. */
  const runAllows = (user: SafeUser, run: Pick<EvalRunView, "workflowId" | "datasetId">, permission: WorkflowPermission): boolean => {
    if (user.role === "admin") return true;
    if (store.getWorkflow(run.workflowId)) return workflowAllows(user, run.workflowId, permission);
    const dataset = store.getEvalDataset(run.datasetId);
    return dataset ? datasetAllows(user, dataset, permission) : false;
  };

  const readableWorkflowIds = (user: SafeUser): string[] =>
    store
      .listWorkflows()
      .filter((workflow) => deps.canAccessWorkflow(user, { id: workflow.id, projectId: workflow.projectId ?? undefined }, "workflow:read"))
      .map((workflow) => workflow.id);

  const forbidden = (reply: FastifyReply, what: string) => {
    reply.code(403);
    return { error: `Insufficient permissions for this ${what}` };
  };

  const notFound = (reply: FastifyReply, what: string) => {
    reply.code(404);
    return { error: `${what} not found` };
  };

  /** 404 when the user cannot even read it (no existence oracle), 403 when they can read but not do this. */
  const denied = (reply: FastifyReply, readable: boolean, what: string, label: string) => (readable ? forbidden(reply, what) : notFound(reply, label));

  /** Judge scorers name a provider secret by reference; the user must be allowed to use it in this project. */
  const judgeSecretProblemInProject = (user: SafeUser, scorers: EvalScorerSpec[] | undefined | null, projectId: string): string | null => {
    for (const scorer of scorers ?? []) {
      if (scorer.type !== "llm_judge" || !scorer.secretRef) continue;
      if (!deps.canUseSecret(user, scorer.secretRef.secretId, projectId)) return `The judge's secret ${scorer.secretRef.secretId} was not found or cannot be used in this workflow's project.`;
    }
    return null;
  };

  const judgeSecretProblem = (user: SafeUser, scorers: EvalScorerSpec[] | undefined | null, workflowId: string): string | null =>
    judgeSecretProblemInProject(user, scorers, store.getWorkflow(workflowId)?.projectId ?? "default");

  /** The first judge secret problem of the request's scorers or of any case in these datasets. */
  const runScorerProblem = (user: SafeUser, scorers: EvalScorerSpec[] | undefined | null, datasetIds: string[], workflowId: string): string | null => {
    const own = judgeSecretProblem(user, scorers, workflowId);
    if (own) return own;
    for (const datasetId of datasetIds) {
      for (const fixture of evals.listFixtures(datasetId)) {
        const problem = judgeSecretProblem(user, fixture.scorers as EvalScorerSpec[] | null, workflowId);
        if (problem) return problem;
      }
    }
    return null;
  };

  const evalRunError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof EvalRunError) {
      reply.code(EVAL_RUN_ERROR_STATUS[error.code]);
      return { error: error.message, code: error.code };
    }
    throw error;
  };

  // ---------------------------------------------------------------------------
  // Datasets and golden sets
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { projectId?: string; workflowId?: string } }>("/api/eval/datasets", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const projectId = typeof request.query.projectId === "string" && request.query.projectId ? request.query.projectId : undefined;
    const workflowId = typeof request.query.workflowId === "string" && request.query.workflowId ? request.query.workflowId : undefined;
    const datasets = evals.listDatasets({ projectId, workflowId }).filter((dataset) => datasetAllows(user, dataset, "workflow:read"));
    return { datasets };
  });

  app.post<{ Body: unknown }>("/api/eval/datasets", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = goldenSetCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues.some((issue) => issue.path[0] === "name") ? "name is required" : firstIssue(parsed.error), details: parsed.error.issues };
    }
    let projectId = parsed.data.projectId;
    if (parsed.data.workflowId) {
      const workflow = store.getWorkflow(parsed.data.workflowId);
      if (!workflow) return notFound(reply, "Workflow");
      if (!workflowAllows(user, workflow.id, "workflow:write")) return denied(reply, workflowAllows(user, workflow.id, "workflow:read"), "workflow", "Workflow");
      // A golden set lives in its workflow's project.
      projectId = workflow.projectId ?? "default";
    } else if (projectId && user.role !== "admin" && !deps.canInProject(user, projectId, "workflow:write")) {
      return forbidden(reply, "project");
    }
    const dataset = evals.createDataset({
      name: parsed.data.name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(projectId ? { projectId } : {}),
      ...(parsed.data.workflowId ? { workflowId: parsed.data.workflowId } : {}),
      createdBy: user.email
    });
    if (dataset?.workflowId) {
      deps.audit(request, user, {
        eventType: "replay.golden_set.created",
        category: "workflow",
        action: "create",
        resourceType: "golden_set",
        resourceId: dataset.id,
        projectId: dataset.projectId,
        metadata: { datasetId: dataset.id, workflowId: dataset.workflowId }
      });
    }
    return { dataset };
  });

  app.delete<{ Params: { id: string } }>("/api/eval/datasets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const dataset = evals.getDataset(request.params.id);
    if (!dataset) return notFound(reply, "Dataset");
    if (!datasetAllows(user, dataset, "workflow:write")) return denied(reply, datasetAllows(user, dataset, "workflow:read"), "dataset", "Dataset");
    evals.deleteDataset(dataset.id);
    if (dataset.workflowId) {
      deps.audit(request, user, {
        eventType: "replay.golden_set.deleted",
        category: "workflow",
        action: "delete",
        resourceType: "golden_set",
        resourceId: dataset.id,
        projectId: dataset.projectId,
        metadata: { datasetId: dataset.id, workflowId: dataset.workflowId }
      });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/eval/datasets/:id/fixtures", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const dataset = evals.getDataset(request.params.id);
    if (!dataset || !datasetAllows(user, dataset, "workflow:read")) return notFound(reply, "Dataset");
    return { fixtures: evals.listFixtures(dataset.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/eval/datasets/:id/fixtures", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = fixtureCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error).replace(/^(name|input): /, ""), details: parsed.error.issues };
    }
    const dataset = evals.getDataset(request.params.id);
    if (!dataset) return notFound(reply, "Dataset");
    if (!datasetAllows(user, dataset, "workflow:write")) return denied(reply, datasetAllows(user, dataset, "workflow:read"), "dataset", "Dataset");
    // Checked for every dataset: a golden set against its workflow's project, any other against its own.
    const problem = dataset.workflowId
      ? judgeSecretProblem(user, parsed.data.scorers, dataset.workflowId)
      : judgeSecretProblemInProject(user, parsed.data.scorers, dataset.projectId ?? "default");
    if (problem) {
      reply.code(400);
      return { error: problem };
    }
    return {
      fixture: evals.addFixture({
        datasetId: dataset.id,
        name: parsed.data.name,
        input: parsed.data.input,
        ...(parsed.data.expected !== undefined ? { expected: parsed.data.expected } : {}),
        ...(parsed.data.scorers ? { scorers: parsed.data.scorers } : {})
      })
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/eval/datasets/:id/recordings", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = goldenSetAddRecordingSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error), details: parsed.error.issues };
    }
    const dataset = evals.getDataset(request.params.id);
    if (!dataset) return notFound(reply, "Golden set");
    if (!datasetAllows(user, dataset, "workflow:write")) return denied(reply, datasetAllows(user, dataset, "workflow:read"), "golden set", "Golden set");
    if (!dataset.workflowId) {
      reply.code(400);
      return { error: "This dataset is not a golden set: create one for a workflow to add golden runs." };
    }
    const recording = store.getReplayRecording(parsed.data.recordingId);
    if (!recording || recording.workflowId !== dataset.workflowId) {
      reply.code(404);
      return { error: "Golden run not found in this workflow" };
    }
    if (store.findEvalFixtureByRecording(dataset.id, recording.id)) {
      reply.code(409);
      return { error: "This golden run is already in the set." };
    }
    const problem = judgeSecretProblem(user, parsed.data.scorers, dataset.workflowId);
    if (problem) {
      reply.code(400);
      return { error: problem };
    }
    const fixture = evals.addGoldenRun({ datasetId: dataset.id, recording, ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(parsed.data.scorers ? { scorers: parsed.data.scorers } : {}) });
    deps.audit(request, user, {
      eventType: "replay.golden_set.case_added",
      category: "workflow",
      action: "update",
      resourceType: "golden_set",
      resourceId: dataset.id,
      projectId: dataset.projectId,
      metadata: { datasetId: dataset.id, recordingId: recording.id, fixtureId: fixture?.id ?? null }
    });
    reply.code(201);
    return { fixture };
  });

  app.delete<{ Params: { id: string } }>("/api/eval/fixtures/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const fixture = evals.getFixture(request.params.id);
    if (!fixture) return notFound(reply, "Fixture");
    const dataset = evals.getDataset(fixture.datasetId);
    // A case whose dataset is gone belongs to no one: only admins clean it up.
    if (!dataset) {
      if (user.role !== "admin") return notFound(reply, "Fixture");
    } else if (!datasetAllows(user, dataset, "workflow:write")) {
      return denied(reply, datasetAllows(user, dataset, "workflow:read"), "dataset", "Fixture");
    }
    evals.deleteFixture(fixture.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Eval runs
  // ---------------------------------------------------------------------------

  app.post<{
    Querystring: { wait?: string };
    Body: { datasetId?: string; workflowId?: string; scorers?: unknown; record?: boolean; replay?: unknown };
  }>("/api/eval/runs", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const datasetId = String(request.body?.datasetId ?? "").trim();
    const workflowId = String(request.body?.workflowId ?? "").trim();
    if (!datasetId || !workflowId) {
      reply.code(400);
      return { error: "datasetId and workflowId are required" };
    }
    const scorers = evalScorerListSchema.optional().safeParse(request.body?.scorers);
    if (!scorers.success) {
      reply.code(400);
      return { error: "Invalid scorers", details: scorers.error.issues };
    }
    const mcpOptions = evalMcpOptionsSchema.safeParse({ record: request.body?.record, replay: request.body?.replay });
    if (!mcpOptions.success) {
      reply.code(400);
      return { error: "Invalid MCP record or replay options", details: mcpOptions.error.issues };
    }
    if (mcpOptions.data.record && mcpOptions.data.replay) {
      reply.code(400);
      return { error: "An eval run can record MCP calls or replay them, not both." };
    }
    if (!workflowAllows(user, workflowId, "workflow:execute")) return denied(reply, workflowAllows(user, workflowId, "workflow:read"), "workflow", "Workflow");
    const dataset = evals.getDataset(datasetId);
    if (!dataset || !datasetAllows(user, dataset, "workflow:read")) return notFound(reply, "Eval dataset");
    if (dataset.workflowId && dataset.workflowId !== workflowId) {
      reply.code(400);
      return { error: "This golden set belongs to another workflow.", code: "invalid" };
    }
    if (mcpOptions.data.replay?.cassetteId && !deps.cassetteAllowed(user, mcpOptions.data.replay.cassetteId)) return notFound(reply, "Cassette");
    if (mcpOptions.data.replay?.evalRunId) {
      const source = evals.getRunView(mcpOptions.data.replay.evalRunId);
      if (!source || !runAllows(user, source, "workflow:read")) return notFound(reply, "Eval run to replay from");
    }
    // The request's judges and every judge stored on the dataset's cases run with this user's rights.
    const problem = runScorerProblem(user, scorers.data, [dataset.id], workflowId);
    if (problem) {
      reply.code(400);
      return { error: problem };
    }
    const runRequest = {
      datasetId,
      workflowId,
      ...(scorers.data ? { scorers: scorers.data } : {}),
      triggeredBy: user.email,
      ...(mcpOptions.data.record ? { recordMcp: true } : {}),
      ...(mcpOptions.data.replay ? { replayMcp: mcpOptions.data.replay } : {})
    };
    if (request.query.wait === "true" || request.query.wait === "1") {
      try {
        // The pre-15.2 blocking response, kept for one release (every refusal is a 400, as it was).
        reply.header("Deprecation", "true");
        const result = await evals.startRun(runRequest);
        return { ok: true, ...result };
      } catch (error) {
        if (error instanceof EvalRunError) {
          reply.code(400);
          return { error: error.message, code: error.code };
        }
        throw error;
      }
    }
    try {
      const run = evals.enqueueRun(runRequest);
      reply.code(202);
      return { run, runId: run.id };
    } catch (error) {
      return evalRunError(reply, error);
    }
  });

  app.get<{ Querystring: { datasetId?: string; workflowId?: string; kind?: string; limit?: string } }>("/api/eval/runs", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const query = request.query;
    const kind = query.kind === "eval" || query.kind === "replay" ? query.kind : undefined;
    const filter = {
      ...(query.datasetId ? { datasetId: query.datasetId } : {}),
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(kind ? { kind: kind as "eval" | "replay" } : {}),
      limit: limitFrom(query.limit, 100)
    };
    if (query.workflowId && !workflowAllows(user, query.workflowId, "workflow:read")) return notFound(reply, "Workflow");
    const runs = user.role === "admin" || query.workflowId ? evals.listRuns(filter) : evals.listRuns({ ...filter, workflowIds: readableWorkflowIds(user) });
    // Phase 10.8 — how many fixture cassettes each run recorded, for "replay from eval run".
    return { runs: runs.map((run) => ({ ...run, mcpCassettes: store.listMcpCassettesForEvalRun(run.id).length })) };
  });

  app.get<{ Params: { id: string } }>("/api/eval/runs/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const run = evals.getRun(request.params.id);
    if (!run || !runAllows(user, run, "workflow:read")) return notFound(reply, "Eval run");
    return run;
  });

  const cancelRun = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, kind?: "replay") => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const existing = evals.getRunView(request.params.id);
    const label = kind ? "Replay job" : "Eval run";
    if (!existing || (kind && existing.kind !== kind) || !runAllows(user, existing, "workflow:read")) return notFound(reply, label);
    if (!runAllows(user, existing, "workflow:execute")) return forbidden(reply, kind ? "replay job" : "eval run");
    if (existing.status !== "queued" && existing.status !== "running") {
      reply.code(409);
      return { error: `The run already finished (${existing.status}).`, run: existing };
    }
    const run = evals.cancel(existing.id);
    deps.audit(request, user, {
      eventType: existing.kind === "replay" ? "replay.job.canceled" : "eval.run.canceled",
      category: "execution",
      action: "cancel",
      resourceType: existing.kind === "replay" ? "replay_job" : "eval_run",
      resourceId: existing.id,
      metadata: { runId: existing.id, workflowId: existing.workflowId }
    });
    return { run };
  };

  app.post<{ Params: { id: string } }>("/api/eval/runs/:id/cancel", async (request, reply) => cancelRun(request, reply));

  app.get<{ Params: { id: string } }>("/api/eval/runs/:id/events", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const run = evals.getRunView(request.params.id);
    if (!run || !runAllows(user, run, "workflow:read")) return notFound(reply, "Eval run");

    let closed = false;
    const send = (event: "progress" | "done", payload: EvalRunView) => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, run: payload })}\n\n`);
    };
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();

    let unsubscribe: (() => void) | null = null;
    let stopHeartbeat: () => void = () => undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      stopHeartbeat();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    request.raw.on("close", finish);

    if (!evals.isActive(run.id)) {
      // Finished, or run by another instance: the stored state is all there is.
      send(EVAL_RUN_FINISHED_STATUSES.has(run.status) ? "done" : "progress", run);
      finish();
      return reply;
    }
    send("progress", run);
    unsubscribe = evals.subscribe(run.id, (view, done) => {
      send(done ? "done" : "progress", view);
      if (done) finish();
    });
    if (!unsubscribe) {
      const latest = evals.getRunView(run.id);
      if (latest) send("done", latest);
      finish();
      return reply;
    }
    stopHeartbeat = startSseHeartbeat(reply.raw, deps.sseHeartbeatMs, () => closed);
    return reply;
  });

  // ---------------------------------------------------------------------------
  // Replay jobs
  // ---------------------------------------------------------------------------

  app.post<{ Body: unknown }>("/api/replay/runs", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = replayJobRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid replay job", details: parsed.error.issues };
    }
    const first = evals.getDataset(parsed.data.datasetIds[0]!);
    if (!first || !datasetAllows(user, first, "workflow:read")) return notFound(reply, "Golden set");
    if (!first.workflowId) {
      reply.code(400);
      return { error: "This dataset is not a golden set: replay jobs need sets made for a workflow." };
    }
    const workflowId = first.workflowId;
    if (!workflowAllows(user, workflowId, "workflow:execute")) return forbidden(reply, "golden set");
    // Every set must be this workflow's before anything about its cases (names, secret ids) is read.
    for (const datasetId of parsed.data.datasetIds) {
      const dataset = evals.getDataset(datasetId);
      if (!dataset || dataset.workflowId !== workflowId) return notFound(reply, "Golden set");
    }
    const scorerProblem = runScorerProblem(user, parsed.data.scorers, [...new Set(parsed.data.datasetIds)], workflowId);
    if (scorerProblem) {
      reply.code(400);
      return { error: scorerProblem };
    }
    let run: EvalRunView;
    try {
      run = evals.enqueueReplayJob(parsed.data, { workflowId, actor: user });
    } catch (error) {
      return evalRunError(reply, error);
    }
    deps.audit(request, user, {
      eventType: "replay.job.started",
      category: "execution",
      action: "execute",
      resourceType: "replay_job",
      resourceId: run.id,
      projectId: store.getWorkflow(workflowId)?.projectId ?? null,
      metadata: { runId: run.id, workflowId, datasetIds: run.datasetIds, candidate: run.candidate, options: run.options }
    });
    reply.code(202);
    return { run };
  });

  app.get<{ Querystring: { workflowId?: string; datasetId?: string; limit?: string } }>("/api/replay/runs", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const query = request.query;
    if (query.workflowId && !workflowAllows(user, query.workflowId, "workflow:read")) return notFound(reply, "Workflow");
    const filter = {
      kind: "replay" as const,
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(query.datasetId ? { datasetId: query.datasetId } : {}),
      limit: limitFrom(query.limit, 50)
    };
    const runs = user.role === "admin" || query.workflowId ? evals.listRuns(filter) : evals.listRuns({ ...filter, workflowIds: readableWorkflowIds(user) });
    return { runs };
  });

  app.get<{ Params: { id: string } }>("/api/replay/runs/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const run = evals.getRun(request.params.id);
    if (!run || run.kind !== "replay" || !runAllows(user, run, "workflow:read")) return notFound(reply, "Replay job");
    return { run: { ...run, results: run.results.map(({ output: _output, ...result }) => result) } };
  });

  app.get<{ Params: { id: string; resultId: string } }>("/api/replay/runs/:id/results/:resultId", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const run = evals.getRunView(request.params.id);
    if (!run || run.kind !== "replay" || !runAllows(user, run, "workflow:read")) return notFound(reply, "Replay job");
    const result = evals.getCase(run.id, request.params.resultId);
    if (!result) {
      reply.code(404);
      return { error: "Case not found" };
    }
    return { result };
  });

  app.post<{ Params: { id: string } }>("/api/replay/runs/:id/cancel", async (request, reply) => cancelRun(request, reply, "replay"));
}
