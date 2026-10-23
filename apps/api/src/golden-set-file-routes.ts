/**
 * Phase 15.5 - golden-set files (format in packages/shared/src/golden-set-file.ts).
 *
 *   GET  /api/eval/datasets/:id/export   the golden set as an `l2m.golden-set` file (viewer);
 *                                        `?sign=true` adds a signature by the deployment's audit key
 *   POST /api/eval/datasets/import       body { file, workflowId, projectId?, name? }: creates a golden
 *                                        set and its golden runs in one go (builder)
 *
 * Access follows eval-routes.ts and run-access.ts: exporting needs
 * `workflow:read` on the set's workflow (a set the user cannot read answers
 * 404); importing needs `workflow:write` on the target workflow (404 when it
 * cannot be read, 403 when it can be read but not written, so an
 * execute-only user cannot import).
 *
 * The importer never trusts the file. Everything in it is scrubbed again with
 * this deployment's secrets, secret references are dropped (also from judge
 * scorers, whose credential the importing user attaches afterwards), the
 * schema, MCP cassette, case count and sizes are checked, and the set and
 * every golden run are created in one SQLite transaction: any failure
 * leaves nothing behind. Both routes answer 501 on Postgres.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_PROJECT_ID,
  GOLDEN_SET_CASE_MAX_BYTES,
  GOLDEN_SET_FILE_FORMAT,
  GOLDEN_SET_FILE_VERSION,
  goldenSetFileSchema,
  goldenSetFileSizeProblem,
  goldenSetImportRequestSchema,
  goldenSetSignedBytes,
  stripSecretReferences,
  type EvalScorerSpec,
  type GoldenSetFile
} from "@ai-orchestrator/shared";
import type { SqliteStore } from "./db/database.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { AuditSigningService } from "./services/audit-signing-service.js";
import { ReplayRecordingError, type ReplayRecordingService } from "./services/replay-recording-service.js";

export interface GoldenSetFileRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  recordings: ReplayRecordingService;
  signing: AuditSigningService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  runAccess: RunAccess;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
  /** False on Postgres: both routes answer 501. */
  available: boolean;
  /** The largest file accepted, and the basis of the import route's request body limit. */
  maxFileBytes: number;
  /** `REPLAY_RECORDING_MAX_BYTES`: the largest single case. */
  maxCaseBytes: number;
  /** `REPLAY_JOB_MAX_CASES`: more cases than a job can run are refused. */
  maxCases: number;
}

const RECORDING_ERROR_STATUS: Record<ReplayRecordingError["code"], number> = {
  not_found: 404,
  in_progress: 409,
  not_allowed: 400,
  duplicate: 409,
  limit: 409,
  too_large: 413,
  invalid: 400
};

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}` : "invalid request";
}

/** A judge scorer without its credential reference. */
function withoutJudgeSecret(scorers: EvalScorerSpec[] | undefined): { scorers: EvalScorerSpec[] | undefined; dropped: number } {
  if (!scorers) return { scorers, dropped: 0 };
  let dropped = 0;
  const cleaned = scorers.map((scorer) => {
    if (scorer.type !== "llm_judge" || !scorer.secretRef) return scorer;
    dropped += 1;
    const { secretRef: _secretRef, ...rest } = scorer;
    return rest as EvalScorerSpec;
  });
  return { scorers: cleaned, dropped };
}

export function registerGoldenSetFileRoutes(deps: GoldenSetFileRoutesDeps): void {
  const { app, store, recordings, requireRole, runAccess } = deps;

  const deny = (reply: FastifyReply, denial: { status: number; error: string }) => {
    reply.code(denial.status);
    return { error: denial.error };
  };
  const unavailable = (reply: FastifyReply) => {
    reply.code(501);
    return { error: "Golden-set files need the SQLite store in this release" };
  };

  app.get<{ Params: { id: string }; Querystring: { sign?: string } }>("/api/eval/datasets/:id/export", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const dataset = store.getEvalDataset(request.params.id);
    if (!dataset) return deny(reply, { status: 404, error: "Golden set not found" });
    // A dataset without a workflow follows its project; either way an unreadable one answers 404 before anything else is said.
    const access = dataset.workflowId
      ? runAccess.workflow(user, dataset.workflowId, "workflow:read", "Golden set")
      : runAccess.project(user, dataset.projectId ?? DEFAULT_PROJECT_ID, "workflow:read", "Golden set");
    if (!access.ok) return deny(reply, access);
    if (!dataset.workflowId) {
      reply.code(400);
      return { error: "This dataset is not a golden set: only golden sets made for a workflow can be exported." };
    }
    const workflow = store.getWorkflow(dataset.workflowId);
    const scrubber = recordings.scrubber();
    const cases: GoldenSetFile["cases"] = [];
    let skipped = 0;
    for (const fixture of store.listEvalFixtures(dataset.id)) {
      const recording = fixture.recordingId ? store.getReplayRecording(fixture.recordingId) : null;
      // A hand-written case, or one whose golden run was deleted, has no recording to carry.
      if (!recording) {
        skipped += 1;
        continue;
      }
      const { scorers } = withoutJudgeSecret((fixture.scorers as EvalScorerSpec[] | null) ?? undefined);
      cases.push({ name: fixture.name, ...(scorers && scorers.length > 0 ? { scorers } : {}), recording: recordings.toFileRecording(recording, scrubber) });
    }
    const exportedAt = new Date().toISOString();
    const file: Record<string, unknown> = {
      format: GOLDEN_SET_FILE_FORMAT,
      version: GOLDEN_SET_FILE_VERSION,
      workflow: { id: dataset.workflowId, name: workflow?.name ?? "" },
      name: dataset.name,
      description: dataset.description,
      exportedAt,
      exportedBy: user.email,
      cases
    };
    const signed = request.query.sign === "true" || request.query.sign === "1";
    if (signed) {
      const keyId = deps.signing.activeKeyId();
      const signature = deps.signing.sign(goldenSetSignedBytes(file, keyId, exportedAt));
      file.signature = { algorithm: "Ed25519", keyId: signature.keyId, publicKey: signature.publicKey, signedAt: exportedAt, signature: signature.signature };
    }
    deps.audit(request, user, {
      eventType: "replay.golden_set.exported",
      category: "workflow",
      action: "read",
      resourceType: "golden_set",
      resourceId: dataset.id,
      projectId: workflow?.projectId ?? dataset.projectId ?? null,
      metadata: { datasetId: dataset.id, workflowId: dataset.workflowId, cases: cases.length, skipped, signed }
    });
    reply.header("x-l2m-skipped-cases", String(skipped));
    reply.header("content-disposition", `attachment; filename="golden-set-${dataset.id}.json"`);
    return file;
  });

  app.post<{ Body: unknown }>(
    "/api/eval/datasets/import",
    { bodyLimit: Math.max(deps.maxFileBytes + 64 * 1024, 1024 * 1024) },
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return reply;
      if (!deps.available) return unavailable(reply);
      const body = goldenSetImportRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        reply.code(400);
        return { error: firstIssue(body.error), details: body.error.issues };
      }
      // The target comes first: someone who cannot write it learns nothing about the file.
      const access = runAccess.workflow(user, body.data.workflowId, "workflow:write", "Workflow");
      if (!access.ok) return deny(reply, access);
      const target = access.workflow;
      const projectId = target.projectId ?? DEFAULT_PROJECT_ID;
      if (body.data.projectId && body.data.projectId !== projectId) {
        reply.code(400);
        return { error: "projectId does not match the project of the target workflow." };
      }
      const parsed = goldenSetFileSchema.safeParse(body.data.file);
      if (!parsed.success) {
        reply.code(400);
        return { error: `Not a valid l2m.golden-set file (${firstIssue(parsed.error)})`, details: parsed.error.issues.slice(0, 20) };
      }
      const file = parsed.data;
      const sizeProblem = goldenSetFileSizeProblem(file, {
        maxBytes: deps.maxFileBytes,
        maxCaseBytes: Math.min(deps.maxCaseBytes, GOLDEN_SET_CASE_MAX_BYTES),
        maxCases: deps.maxCases
      });
      if (sizeProblem) {
        reply.code(413);
        return { error: sizeProblem };
      }

      const warnings: string[] = [];
      if (file.workflow.id !== target.id) {
        warnings.push(`The file was exported from workflow ${file.workflow.id} (${file.workflow.name || "unnamed"}); its cases were imported into ${target.id} as asked.`);
      }
      if (file.signature) {
        const bytes = goldenSetSignedBytes(body.data.file as Record<string, unknown>, file.signature.keyId, file.signature.signedAt);
        if (!deps.signing.verify(file.signature.keyId, bytes, file.signature.signature)) {
          warnings.push(
            `The file is signed with key ${file.signature.keyId.slice(0, 16)}, which this deployment cannot verify. Everything in it was scrubbed and checked on import as for any file; verify the signature with 'l2m golden verify' and the exporting deployment's public key.`
          );
        }
      }
      const scrubber = recordings.scrubber();
      let droppedJudgeSecrets = 0;
      let ignoredTapes = 0;
      const name = body.data.name ?? file.name;
      const datasetId = `ds_${randomUUID()}`;
      let imported = 0;
      try {
        store.transaction(() => {
          store.createEvalDataset({
            id: datasetId,
            name,
            ...(file.description ? { description: file.description } : {}),
            projectId,
            workflowId: target.id,
            createdBy: user.email
          });
          for (const entry of file.cases) {
            const summary = recordings.importRecording({ workflowId: target.id, projectId, recording: entry.recording, name: entry.recording.name }, user.email, scrubber);
            const record = store.getReplayRecording(summary.id)!;
            const { scorers, dropped } = withoutJudgeSecret(entry.scorers);
            droppedJudgeSecrets += dropped;
            if (entry.recording.modelTape !== undefined || entry.recording.memorySeed !== undefined) ignoredTapes += 1;
            store.createEvalFixture({
              id: `fix_${randomUUID()}`,
              datasetId,
              name: entry.name,
              input: record.input ?? null,
              ...(scorers && scorers.length > 0 ? { scorers: scorers as unknown as Array<Record<string, unknown>> } : {}),
              recordingId: record.id
            });
            imported += 1;
          }
        });
      } catch (error) {
        if (error instanceof ReplayRecordingError) {
          reply.code(RECORDING_ERROR_STATUS[error.code]);
          return { error: error.message, code: error.code };
        }
        throw error;
      }
      if (droppedJudgeSecrets > 0) {
        warnings.push(`${droppedJudgeSecrets} judge scorer${droppedJudgeSecrets === 1 ? "" : "s"} lost the credential reference: attach one before running the judge.`);
      }
      if (ignoredTapes > 0) {
        warnings.push(`${ignoredTapes} case${ignoredTapes === 1 ? "" : "s"} carried a model tape or memory seed, which this server does not store; they were not imported.`);
      }
      const dataset = store.getEvalDataset(datasetId);
      deps.audit(request, user, {
        eventType: "replay.golden_set.imported",
        category: "workflow",
        action: "create",
        resourceType: "golden_set",
        resourceId: datasetId,
        projectId,
        metadata: { datasetId, workflowId: target.id, sourceWorkflowId: file.workflow.id, cases: imported, signed: Boolean(file.signature), warnings: warnings.length }
      });
      reply.code(201);
      return { dataset, imported, skipped: 0, warnings };
    }
  );
}
