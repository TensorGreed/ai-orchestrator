/**
 * Evals (Phase 7.3, 9.5, 10.8) and replay jobs (Phase 15.2).
 *
 *   GET    /api/eval/datasets                       datasets and golden sets the user can read (viewer)
 *   POST   /api/eval/datasets                       create one; `workflowId` makes it a golden set (builder)
 *   DELETE /api/eval/datasets/:id                   (builder)
 *   GET    /api/eval/datasets/:id/fixtures          (viewer)
 *   POST   /api/eval/datasets/:id/fixtures          a hand-written case (builder)
 *   POST   /api/eval/datasets/:id/recordings        a golden run as a case of a golden set (builder)
 *   DELETE /api/eval/fixtures/:id                   (builder; an admitted case of an enforced release gate: admins only)
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
 * Access goes through the shared run-access helper (run-access.ts), with
 * its 404/403 rules: something the user cannot read answers 404, as if it
 * did not exist; something they can read but not act on answers 403; admins
 * always pass.
 *
 *   - A golden set and every run belong to a workflow: reading needs
 *     `workflow:read` on it, editing a set `workflow:write`, starting or
 *     canceling a run `workflow:execute`. A run whose workflow was deleted is
 *     admin-only.
 *   - A dataset without a workflow follows its project (`workflow:read` /
 *     `workflow:write` there). One with neither (made before projects scoped
 *     datasets) is readable by builders and admins in `role` isolation; in
 *     `strict` isolation it counts as a default-project dataset for reads and
 *     writes. New datasets without a workflow or project are stored in the
 *     default project.
 *   - Lists are narrowed to readable workflows and projects before the limit.
 *   - An eval run needs `workflow:execute` on the workflow and read access to
 *     the dataset; a cassette or eval run it replays MCP answers from must be
 *     readable (404) and recorded for the same workflow (409).
 *   - A replay job needs `workflow:execute` on the sets' workflow, and every
 *     set must be that workflow's before anything about its cases is read.
 *
 * A judge scorer's `secretRef` (on the request or on any case of the set)
 * must name a secret the starting user may use in the workflow's project;
 * the judge checks it again for every call. The runs themselves execute in
 * the background with the starting user's project scope (run-scope.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { candidateRefusal } from "./services/candidate-policy.js";
import { z } from "zod";
import {
  DEFAULT_PROJECT_ID,
  EVAL_RUN_FINISHED_STATUSES,
  evalScorerListSchema,
  goldenSetAddRecordingSchema,
  goldenSetCreateSchema,
  GUARD_SIMULATION_JOB_DATASET_PREFIX,
  replayJobRequestSchema,
  type EvalCaseResult,
  type EvalRunView,
  type EvalScorerSpec,
  type ReleaseGateJobAdmission,
  type ReplayJobRequest
} from "@ai-orchestrator/shared";
import type { EvalDatasetRecord, SqliteStore } from "./db/database.js";
import type { RunAccess, RunAccessDenial } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { EvalRunError, type EvalService } from "./services/eval-service.js";
import { startSseHeartbeat } from "./sse-heartbeat.js";

type DatasetPermission = "workflow:read" | "workflow:write";

export interface EvalRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  evals: EvalService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** The shared project authorization helper (run-access.ts). */
  runAccess: RunAccess;
  /** Answers a run-access denial with its status and error. */
  denyRunAccess: (reply: FastifyReply, denial: { status: number; error: string }) => { error: string };
  /** Whether `user` may hand this secret to a judge running for this workflow (or, without one, in this project). */
  canUseSecret: (user: SafeUser, secretId: string, scope: { id?: string; projectId?: string | null }) => boolean;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
  sseHeartbeatMs: number;
  /** `strict` isolation: a dataset made before projects scoped datasets belongs to the default project. */
  strictIsolation: boolean;
  /**
   * Phase 15.4 — why this change to a golden set is refused (an enforced
   * release gate uses the set: only admins remove cases, delete it or add a
   * case with its own scorers); null when it is allowed.
   */
  goldenSetChangeDenial?: (user: SafeUser, datasetId: string, change: "remove_case" | "delete_set" | "add_case_with_scorers", target?: { fixtureId?: string }) => string | null;
  /**
   * Release gate admission — the admitted and required cases of the
   * workflow's enforced gate when it uses one of the job's golden sets, and
   * how the gate judges the job's case results, for the replay job view;
   * null otherwise.
   */
  releaseGateAdmission?: (run: EvalRunView & { results: EvalCaseResult[] }) => ReleaseGateJobAdmission | null;
  /**
   * Release gate admission — before a delete that can take admitted cases
   * from the workflow's enforced gate: a function that audits it once the
   * delete is done; null when it takes none.
   */
  gateCasesRemoval?: (user: SafeUser, workflowId: string, target: { via: "fixture"; fixtureId: string } | { via: "golden_set"; datasetId: string }) => (() => void) | null;
}

const EVAL_RUN_ERROR_STATUS: Record<EvalRunError["code"], number> = { not_found: 404, invalid: 400, limit: 409, forbidden: 403 };

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

  const { runAccess, denyRunAccess } = deps;

  /**
   * A dataset follows its workflow (a golden set), else its project; one with
   * neither is the default project's in strict isolation, else readable by
   * builders and written to as the default project's.
   */
  const datasetAccess = (
    user: SafeUser,
    dataset: EvalDatasetRecord | null | undefined,
    permission: DatasetPermission,
    what = "Dataset"
  ): { ok: true; dataset: EvalDatasetRecord } | RunAccessDenial => {
    if (!dataset) return { ok: false, status: 404, error: `${what} not found` };
    if (user.role === "admin") return { ok: true, dataset };
    if (dataset.workflowId) {
      const access = runAccess.workflow(user, dataset.workflowId, permission, what);
      return access.ok ? { ok: true, dataset } : access;
    }
    if (!dataset.projectId && permission === "workflow:read" && !deps.strictIsolation) {
      return user.role === "builder" ? { ok: true, dataset } : { ok: false, status: 404, error: `${what} not found` };
    }
    const access = runAccess.project(user, dataset.projectId, permission, what);
    return access.ok ? { ok: true, dataset } : access;
  };

  /** The project a dataset is in now: a golden set follows its workflow, which may have moved. */
  const datasetProjectId = (dataset: EvalDatasetRecord): string | null =>
    dataset.workflowId ? (store.getWorkflow(dataset.workflowId)?.projectId ?? DEFAULT_PROJECT_ID) : dataset.projectId;

  const notFound = (reply: FastifyReply, what: string) => denyRunAccess(reply, { status: 404, error: `${what} not found` });

  /** The run filter for the user: runs of readable workflows only (`undefined` for admins). */
  const readableWorkflowFilter = (user: SafeUser): { workflowIds?: string[] } => {
    const ids = runAccess.readableWorkflowIds(user);
    return ids ? { workflowIds: ids } : {};
  };

  /** Judge scorers name a provider secret by reference; the user must be allowed to use it in this project. */
  const judgeSecretProblemFor = (user: SafeUser, scorers: EvalScorerSpec[] | undefined | null, scope: { id?: string; projectId?: string | null }): string | null => {
    for (const scorer of scorers ?? []) {
      if (scorer.type !== "llm_judge" || !scorer.secretRef) continue;
      if (!deps.canUseSecret(user, scorer.secretRef.secretId, scope)) return `The judge's secret ${scorer.secretRef.secretId} was not found or cannot be used in this workflow's project.`;
    }
    return null;
  };

  const judgeSecretProblem = (user: SafeUser, scorers: EvalScorerSpec[] | undefined | null, workflowId: string): string | null =>
    judgeSecretProblemFor(user, scorers, store.getWorkflow(workflowId) ?? { id: workflowId });

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
    const workflows = runAccess.readableWorkflowIds(user);
    const projects = runAccess.readableProjectIds(user);
    const readableWorkflows = workflows && new Set(workflows);
    const readableProjects = projects && new Set(projects);
    // The project filter is applied here, not in SQL, so golden sets match the project their workflow is in now.
    const datasets = evals.listDatasets({ workflowId }).filter((dataset) => {
      const inProject = datasetProjectId(dataset) ?? (deps.strictIsolation ? DEFAULT_PROJECT_ID : null);
      if (projectId && inProject !== projectId) return false;
      if (user.role === "admin") return true;
      if (dataset.workflowId) return Boolean(readableWorkflows?.has(dataset.workflowId));
      if (inProject) return Boolean(readableProjects?.has(inProject));
      return user.role === "builder";
    });
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
      const access = runAccess.workflow(user, parsed.data.workflowId, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
      // A golden set lives in its workflow's project.
      projectId = access.workflow.projectId ?? DEFAULT_PROJECT_ID;
    } else {
      // No project means the default project's, and the dataset is stored there.
      projectId = projectId ?? DEFAULT_PROJECT_ID;
      const access = runAccess.project(user, projectId, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
    }
    const dataset = evals.createDataset({
      name: parsed.data.name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      projectId,
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
        projectId: datasetProjectId(dataset),
        metadata: { datasetId: dataset.id, workflowId: dataset.workflowId }
      });
    }
    return { dataset };
  });

  app.delete<{ Params: { id: string } }>("/api/eval/datasets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const access = datasetAccess(user, evals.getDataset(request.params.id), "workflow:write");
    if (!access.ok) return denyRunAccess(reply, access);
    const dataset = access.dataset;
    const gateDenial = deps.goldenSetChangeDenial?.(user, dataset.id, "delete_set");
    if (gateDenial) return denyRunAccess(reply, { status: 403, error: gateDenial });
    const gateCasesRemoved = dataset.workflowId ? deps.gateCasesRemoval?.(user, dataset.workflowId, { via: "golden_set", datasetId: dataset.id }) : null;
    evals.deleteDataset(dataset.id);
    gateCasesRemoved?.();
    if (dataset.workflowId) {
      deps.audit(request, user, {
        eventType: "replay.golden_set.deleted",
        category: "workflow",
        action: "delete",
        resourceType: "golden_set",
        resourceId: dataset.id,
        projectId: datasetProjectId(dataset),
        metadata: { datasetId: dataset.id, workflowId: dataset.workflowId }
      });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/eval/datasets/:id/fixtures", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const access = datasetAccess(user, evals.getDataset(request.params.id), "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    return { fixtures: evals.listFixtures(access.dataset.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/eval/datasets/:id/fixtures", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = fixtureCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error).replace(/^(name|input): /, ""), details: parsed.error.issues };
    }
    const access = datasetAccess(user, evals.getDataset(request.params.id), "workflow:write");
    if (!access.ok) return denyRunAccess(reply, access);
    const dataset = access.dataset;
    const gateDenial = parsed.data.scorers && parsed.data.scorers.length > 0 ? deps.goldenSetChangeDenial?.(user, dataset.id, "add_case_with_scorers") : null;
    if (gateDenial) return denyRunAccess(reply, { status: 403, error: gateDenial });
    // Checked for every dataset: a golden set against its workflow's project, any other against its own.
    const problem = dataset.workflowId
      ? judgeSecretProblem(user, parsed.data.scorers, dataset.workflowId)
      : judgeSecretProblemFor(user, parsed.data.scorers, { projectId: dataset.projectId });
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
    const access = datasetAccess(user, evals.getDataset(request.params.id), "workflow:write", "Golden set");
    if (!access.ok) return denyRunAccess(reply, access);
    const dataset = access.dataset;
    if (!dataset.workflowId) {
      reply.code(400);
      return { error: "This dataset is not a golden set: create one for a workflow to add golden runs." };
    }
    const recording = store.getReplayRecording(parsed.data.recordingId);
    if (!recording || recording.workflowId !== dataset.workflowId) {
      reply.code(404);
      return { error: "Golden run not found in this workflow" };
    }
    // Phase 15.6 — a captured run joins a golden set by being promoted (which re-scrubs it and checks the limits).
    const refusal = candidateRefusal(recording);
    if (refusal) {
      reply.code(409);
      return { error: refusal };
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
    const gateDenial = parsed.data.scorers && parsed.data.scorers.length > 0 ? deps.goldenSetChangeDenial?.(user, dataset.id, "add_case_with_scorers") : null;
    if (gateDenial) return denyRunAccess(reply, { status: 403, error: gateDenial });
    const fixture = evals.addGoldenRun({ datasetId: dataset.id, recording, ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(parsed.data.scorers ? { scorers: parsed.data.scorers } : {}) });
    deps.audit(request, user, {
      eventType: "replay.golden_set.case_added",
      category: "workflow",
      action: "update",
      resourceType: "golden_set",
      resourceId: dataset.id,
      projectId: datasetProjectId(dataset),
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
    // A case whose dataset is gone belongs to no one: only admins clean it up.
    const dataset = evals.getDataset(fixture.datasetId);
    if (dataset || user.role !== "admin") {
      const access = datasetAccess(user, dataset, "workflow:write", "Fixture");
      if (!access.ok) return denyRunAccess(reply, access);
    }
    const gateDenial = dataset ? deps.goldenSetChangeDenial?.(user, dataset.id, "remove_case", { fixtureId: fixture.id }) : null;
    if (gateDenial) return denyRunAccess(reply, { status: 403, error: gateDenial });
    const gateCasesRemoved = dataset?.workflowId ? deps.gateCasesRemoval?.(user, dataset.workflowId, { via: "fixture", fixtureId: fixture.id }) : null;
    evals.deleteFixture(fixture.id);
    gateCasesRemoved?.();
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
    const workflowAccess = runAccess.workflow(user, workflowId, "workflow:execute");
    if (!workflowAccess.ok) return denyRunAccess(reply, workflowAccess);
    // Another project's dataset reads as missing: its cases never run through your workflow.
    const datasetResult = datasetAccess(user, evals.getDataset(datasetId), "workflow:read");
    if (!datasetResult.ok) return denyRunAccess(reply, datasetResult);
    const dataset = datasetResult.dataset;
    if (dataset.workflowId && dataset.workflowId !== workflowId) {
      reply.code(400);
      return { error: "This golden set belongs to another workflow.", code: "invalid" };
    }
    // Replay sources must be readable (else 404, as if missing) and recorded
    // for this same workflow (else 409).
    const replaySource = mcpOptions.data.replay;
    if (replaySource?.cassetteId) {
      const summary = store.getMcpCassetteSummary(replaySource.cassetteId);
      const access = runAccess.run(user, summary && { id: summary.id, workflowId: summary.workflowId ?? "" }, "workflow:read", "Cassette");
      if (!access.ok) return denyRunAccess(reply, access);
      if (summary?.workflowId !== workflowId) {
        reply.code(409);
        return { error: "That cassette was recorded for a different workflow." };
      }
    } else if (replaySource?.evalRunId) {
      const access = runAccess.run(user, evals.getRunView(replaySource.evalRunId), "workflow:read", "Eval run");
      if (!access.ok) return denyRunAccess(reply, access);
      if (access.run.workflowId !== workflowId) {
        reply.code(409);
        return { error: "That eval run was recorded for a different workflow." };
      }
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
      triggeredByUserId: user.id,
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
          reply.code(error.code === "forbidden" ? 403 : 400);
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
      // Phase 15.6 — a guard policy simulation's jobs are listed only when their own dataset id is asked for.
      ...(query.datasetId?.startsWith(GUARD_SIMULATION_JOB_DATASET_PREFIX) ? {} : { excludeSimulations: true }),
      limit: limitFrom(query.limit, 100)
    };
    if (query.workflowId) {
      const access = runAccess.workflow(user, query.workflowId, "workflow:read");
      if (!access.ok) return denyRunAccess(reply, access);
    }
    // Narrowed to readable workflows in SQL, before the limit.
    const runs = evals.listRuns({ ...filter, ...readableWorkflowFilter(user) });
    // Phase 10.8 — how many fixture cassettes each run recorded, for "replay from eval run".
    return { runs: runs.map((run) => ({ ...run, mcpCassettes: store.listMcpCassettesForEvalRun(run.id).length })) };
  });

  app.get<{ Params: { id: string } }>("/api/eval/runs/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const access = runAccess.run(user, evals.getRun(request.params.id), "workflow:read", "Eval run");
    if (!access.ok) return denyRunAccess(reply, access);
    return access.run;
  });

  const cancelRun = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, kind?: "replay") => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const found = evals.getRunView(request.params.id);
    const access = runAccess.run(user, found && (!kind || found.kind === kind) ? found : null, "workflow:execute", kind ? "Replay job" : "Eval run");
    if (!access.ok) return denyRunAccess(reply, access);
    const existing = access.run;
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
      projectId: store.getWorkflow(existing.workflowId)?.projectId ?? DEFAULT_PROJECT_ID,
      metadata: { runId: existing.id, workflowId: existing.workflowId }
    });
    return { run };
  };

  app.post<{ Params: { id: string } }>("/api/eval/runs/:id/cancel", async (request, reply) => cancelRun(request, reply));

  app.get<{ Params: { id: string } }>("/api/eval/runs/:id/events", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const access = runAccess.run(user, evals.getRunView(request.params.id), "workflow:read", "Eval run");
    if (!access.ok) return denyRunAccess(reply, access);
    const run = access.run;

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

  /**
   * The checks a replay job request passes before it is run or estimated:
   * the body, the golden sets (readable, all of one workflow), the right to
   * run that workflow and, for a candidate that is not a saved draft or
   * version (an inline workflow file, or any override), the right to edit it
   * (Phase 15.3), and the scorers' references.
   */
  const checkReplayJobRequest = (
    user: SafeUser,
    body: unknown,
    reply: FastifyReply
  ): { ok: true; request: ReplayJobRequest; workflowId: string } | { ok: false; response: unknown } => {
    const parsed = replayJobRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, response: { error: "Invalid replay job", details: parsed.error.issues } };
    }
    const firstAccess = datasetAccess(user, evals.getDataset(parsed.data.datasetIds[0]!), "workflow:read", "Golden set");
    if (!firstAccess.ok) return { ok: false, response: denyRunAccess(reply, firstAccess) };
    const first = firstAccess.dataset;
    if (!first.workflowId) {
      reply.code(400);
      return { ok: false, response: { error: "This dataset is not a golden set: replay jobs need sets made for a workflow." } };
    }
    const workflowId = first.workflowId;
    const workflowAccess = runAccess.workflow(user, workflowId, "workflow:execute", "Golden set");
    if (!workflowAccess.ok) return { ok: false, response: denyRunAccess(reply, workflowAccess) };
    // An unsaved candidate is a change to the workflow, so it needs the right to make one.
    if (parsed.data.workflow !== undefined || parsed.data.overrides !== undefined) {
      const writeAccess = runAccess.workflow(user, workflowId, "workflow:write", "Golden set");
      if (!writeAccess.ok) {
        if (writeAccess.status === 403) {
          reply.code(403);
          return { ok: false, response: { error: "Replaying an uploaded workflow or a candidate with overrides needs permission to edit this workflow (workflow:write)." } };
        }
        return { ok: false, response: denyRunAccess(reply, writeAccess) };
      }
    }
    // Every set must be this workflow's before anything about its cases (names, secret ids) is read.
    for (const datasetId of parsed.data.datasetIds) {
      const dataset = evals.getDataset(datasetId);
      if (!dataset || dataset.workflowId !== workflowId) return { ok: false, response: notFound(reply, "Golden set") };
    }
    const scorerProblem = runScorerProblem(user, parsed.data.scorers, [...new Set(parsed.data.datasetIds)], workflowId);
    if (scorerProblem) {
      reply.code(400);
      return { ok: false, response: { error: scorerProblem } };
    }
    // Phase 15.3 — a model override's secret is used like any other: the user must be allowed to use it in this workflow's project.
    for (const override of parsed.data.overrides?.models ?? []) {
      if (override.secretRef && !deps.canUseSecret(user, override.secretRef.secretId, store.getWorkflow(workflowId) ?? { id: workflowId })) {
        reply.code(400);
        return { ok: false, response: { error: `The model override's secret ${override.secretRef.secretId} was not found or cannot be used in this workflow's project.` } };
      }
    }
    return { ok: true, request: parsed.data, workflowId };
  };

  // Golden runs, golden sets and replay jobs are SQLite-only in this release.
  const replayStoreReady = typeof (store as unknown as { getReplayRecording?: unknown }).getReplayRecording === "function";
  const replayUnavailable = (reply: FastifyReply) => {
    reply.code(501);
    return { error: "Replay jobs need the SQLite store in this release." };
  };

  app.post<{ Body: unknown }>("/api/replay/runs", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!replayStoreReady) return replayUnavailable(reply);
    const checked = checkReplayJobRequest(user, request.body, reply);
    if (!checked.ok) return checked.response;
    const { workflowId } = checked;
    let run: EvalRunView;
    try {
      run = evals.enqueueReplayJob(checked.request, { workflowId, actor: user });
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

  // Phase 15.3 — what a replay job would run and cost, checked exactly like starting it; nothing runs.
  app.post<{ Body: unknown }>("/api/replay/estimate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!replayStoreReady) return replayUnavailable(reply);
    const checked = checkReplayJobRequest(user, request.body, reply);
    if (!checked.ok) return checked.response;
    try {
      return evals.estimateReplayJob(checked.request, { workflowId: checked.workflowId, actor: user });
    } catch (error) {
      return evalRunError(reply, error);
    }
  });

  app.get<{ Querystring: { workflowId?: string; datasetId?: string; limit?: string } }>("/api/replay/runs", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const query = request.query;
    if (query.workflowId) {
      const access = runAccess.workflow(user, query.workflowId, "workflow:read");
      if (!access.ok) return denyRunAccess(reply, access);
    }
    const filter = {
      kind: "replay" as const,
      // Phase 15.6 — a guard policy simulation's jobs are reached from the simulation.
      excludeSimulations: true,
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(query.datasetId ? { datasetId: query.datasetId } : {}),
      limit: limitFrom(query.limit, 50)
    };
    const runs = evals.listRuns({ ...filter, ...readableWorkflowFilter(user) });
    return { runs };
  });

  app.get<{ Params: { id: string } }>("/api/replay/runs/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const found = evals.getRun(request.params.id);
    const access = runAccess.run(user, found?.kind === "replay" ? found : null, "workflow:read", "Replay job");
    if (!access.ok) return denyRunAccess(reply, access);
    const run = access.run;
    const releaseGate = deps.releaseGateAdmission?.(run) ?? null;
    return { run: { ...run, ...(releaseGate ? { releaseGate } : {}), results: run.results.map(({ output: _output, ...result }) => result) } };
  });

  app.get<{ Params: { id: string; resultId: string } }>("/api/replay/runs/:id/results/:resultId", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const found = evals.getRunView(request.params.id);
    const access = runAccess.run(user, found?.kind === "replay" ? found : null, "workflow:read", "Replay job");
    if (!access.ok) return denyRunAccess(reply, access);
    const run = access.run;
    const result = evals.getCase(run.id, request.params.resultId);
    if (!result) {
      reply.code(404);
      return { error: "Case not found" };
    }
    return { result };
  });

  app.post<{ Params: { id: string } }>("/api/replay/runs/:id/cancel", async (request, reply) => cancelRun(request, reply, "replay"));
}
