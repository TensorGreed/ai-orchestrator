/**
 * Phase 15.5 - golden-set files (format in packages/shared/src/golden-set-file.ts).
 *
 *   GET  /api/eval/datasets/:id/export   the golden set as an `l2m.golden-set` file (viewer);
 *                                        `?sign=true` adds a signature by the deployment's audit key
 *                                        (admins only: the same people who manage the signing keys)
 *   POST /api/eval/datasets/import       body { file, workflowId, projectId?, name?, allowWorkflowMismatch? }:
 *                                        creates a golden set and its golden runs in one go (builder)
 *
 * Access follows eval-routes.ts and run-access.ts: exporting needs
 * `workflow:read` on the set's workflow (a set the user cannot read answers
 * 404); importing needs `workflow:write` on the target workflow (404 when it
 * cannot be read, 403 when it can be read but not written, so an
 * execute-only user cannot import).
 *
 * The importer never trusts the file. The caller is authenticated in an
 * `onRequest` hook, before the body is read, and the body is capped by
 * `GOLDEN_SET_IMPORT_MAX_BYTES`. A file nested deeper than 64 levels is
 * refused before anything else looks at it. A file exported from another
 * workflow is refused unless the request sets `allowWorkflowMismatch`, and
 * then only recorded outputs of nodes whose id and type match the target are
 * kept. One generic deep scrub runs over the whole file first (every string
 * anywhere, scorers, names and descriptions included; token-shaped or secret
 * object keys become `[REDACTED_KEY_n]`), header and then case by case with a
 * yield between cases; only scrubbed values are stored or echoed. A case's
 * `recordedAt` must be a valid timestamp not before 2000-01-01. Export runs
 * the same scrub and refuses (413) a file over the import limit. Every field
 * of every case also gets the full recording-time scrub
 * (credential key names, token shapes, this deployment's secret values) and
 * loses its secret references (also judge scorers, whose credential the
 * importing user attaches afterwards); each case's workflow hash is
 * recomputed and must match. That work runs case by case, yielding to the
 * event loop between cases, before the transaction; the transaction then
 * only inserts the set and every golden run: any failure leaves nothing
 * behind. Imported golden runs are marked `origin: "imported"` with the
 * claimed recording time and the source workflow id. Both routes answer 501
 * on Postgres.
 */

import { randomUUID } from "node:crypto";
import { candidateRefusal } from "./services/candidate-policy.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_PROJECT_ID,
  GOLDEN_SET_CASE_MAX_BYTES,
  GOLDEN_SET_FILE_FORMAT,
  GOLDEN_SET_FILE_MAX_CASES,
  GOLDEN_SET_FILE_MAX_DEPTH,
  GOLDEN_SET_FILE_VERSION,
  goldenSetFileCaseSchema,
  goldenSetFileSchema,
  goldenSetImportRequestSchema,
  goldenSetSignedBytes,
  jsonDepthExceeds,
  type EvalScorerSpec,
  type GoldenSetFile,
  type GoldenSetFileCase
} from "@ai-orchestrator/shared";
import { z } from "zod";
import type { SqliteStore } from "./db/database.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { AuditSigningService } from "./services/audit-signing-service.js";
import { MIN_RECORDED_AT_MS, ReplayRecordingError, type PreparedImport, type ReplayRecordingService } from "./services/replay-recording-service.js";

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
  /** `GOLDEN_SET_IMPORT_MAX_BYTES`: the largest file accepted, and the basis of the import route's request body limit. */
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

/** The file without its cases checked first; each case is checked on its own, yielding between cases. */
const goldenSetFileHeaderSchema = goldenSetFileSchema.extend({ cases: z.array(z.unknown()).max(GOLDEN_SET_FILE_MAX_CASES) });

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");

/** Lets other requests run between two expensive steps. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function registerGoldenSetFileRoutes(deps: GoldenSetFileRoutesDeps): void {
  const { app, store, recordings, requireRole, runAccess } = deps;
  /** The user the import route's onRequest hook authenticated, per request. */
  const importUsers = new WeakMap<FastifyRequest, SafeUser>();

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
    const signed = request.query.sign === "true" || request.query.sign === "1";
    // Signing uses the deployment's audit key, which only admins manage (GET/POST /api/audit/signing-keys).
    if (signed && user.role !== "admin") {
      return deny(reply, { status: 403, error: "Only admins can sign a golden-set file with the deployment's audit key; export it unsigned." });
    }
    const workflow = store.getWorkflow(dataset.workflowId);
    const scrubber = recordings.scrubber();
    // One numbering of redacted object keys across the whole file.
    const redactedKeys = new Map<string, string>();
    const cases: GoldenSetFile["cases"] = [];
    const header = recordings.scrubFileValue(
      { workflow: { id: dataset.workflowId, name: workflow?.name ?? "" }, name: dataset.name, description: dataset.description },
      scrubber,
      redactedKeys
    );
    let total = jsonBytes(header);
    let skipped = 0;
    for (const fixture of store.listEvalFixtures(dataset.id)) {
      const recording = fixture.recordingId ? store.getReplayRecording(fixture.recordingId) : null;
      // A hand-written case, or one whose golden run was deleted, has no recording to carry; a captured candidate is not a golden run yet.
      if (!recording || candidateRefusal(recording)) {
        skipped += 1;
        continue;
      }
      // A golden run of another workflow never rides along (it could belong to another project).
      if (recording.workflowId !== dataset.workflowId) {
        reply.code(409);
        return { error: `Case ${JSON.stringify(fixture.name)} uses a golden run of another workflow; remove it from the golden set before exporting.` };
      }
      const { scorers } = withoutJudgeSecret((fixture.scorers as EvalScorerSpec[] | null) ?? undefined);
      // The generic deep scrub over everything the case carries, then the file hash of the scrubbed workflow.
      const entry = recordings.scrubFileValue(
        {
          name: fixture.name,
          ...(scorers && scorers.length > 0 ? { scorers } : {}),
          recording: recordings.scrubFileRecording(recordings.toFileRecording(recording, scrubber), scrubber, redactedKeys, false)
        },
        scrubber,
        redactedKeys
      ) as GoldenSetFile["cases"][number];
      total += jsonBytes(entry);
      if (total > deps.maxFileBytes) {
        reply.code(413);
        return { error: `This golden set is over ${deps.maxFileBytes} bytes (GOLDEN_SET_IMPORT_MAX_BYTES), the largest file that can be imported again. Split it into smaller golden sets.` };
      }
      cases.push(entry);
      await yieldToEventLoop();
    }
    const exportedAt = new Date().toISOString();
    const file: Record<string, unknown> = {
      format: GOLDEN_SET_FILE_FORMAT,
      version: GOLDEN_SET_FILE_VERSION,
      workflow: header.workflow,
      name: header.name,
      description: header.description,
      exportedAt,
      exportedBy: user.email,
      cases
    };
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
      metadata: {
        datasetId: dataset.id,
        workflowId: dataset.workflowId,
        cases: cases.length,
        imported: cases.filter((entry) => entry.recording.origin === "imported").length,
        skipped,
        signed,
        ...(signed ? { keyId: (file.signature as { keyId: string }).keyId } : {})
      }
    });
    reply.header("x-l2m-skipped-cases", String(skipped));
    reply.header("content-disposition", `attachment; filename="golden-set-${dataset.id}.json"`);
    return file;
  });

  app.post<{ Body: unknown }>(
    "/api/eval/datasets/import",
    {
      bodyLimit: deps.maxFileBytes + 64 * 1024,
      // Authenticate before the body is read: an anonymous upload is refused without being parsed.
      onRequest: async (request, reply) => {
        const user = await requireRole(request, reply, ["builder"]);
        if (!user) return reply;
        if (!deps.available) return reply.code(501).send({ error: "Golden-set files need the SQLite store in this release" });
        importUsers.set(request, user);
      }
    },
    async (request, reply) => {
      const user = importUsers.get(request);
      if (!user) {
        reply.code(401);
        return { error: "Authentication required" };
      }
      // Depth first: every later check walks the value recursively.
      if (jsonDepthExceeds((request.body as { file?: unknown } | null)?.file ?? null, GOLDEN_SET_FILE_MAX_DEPTH)) {
        reply.code(400);
        return { error: `The file is nested deeper than ${GOLDEN_SET_FILE_MAX_DEPTH} levels.` };
      }
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
      const header = goldenSetFileHeaderSchema.safeParse(body.data.file);
      if (!header.success) {
        reply.code(400);
        return { error: `Not a valid l2m.golden-set file (${firstIssue(header.error)})`, details: header.error.issues.slice(0, 20) };
      }
      const maxCases = Math.min(deps.maxCases, GOLDEN_SET_FILE_MAX_CASES);
      if (header.data.cases.length > maxCases) {
        reply.code(413);
        return { error: `The file has ${header.data.cases.length} cases; at most ${maxCases} can be imported.` };
      }
      // The generic deep scrub of everything outside the cases (each case follows below, one at a time):
      // from here on only scrubbed values are used, stored or echoed. The signature is verified over the original bytes.
      const scrubber = recordings.scrubber();
      const redactedKeys = new Map<string, string>();
      const { cases: rawCases, signature: rawSignature, ...headerFields } = header.data;
      const fileHeader = {
        ...recordings.scrubFileValue(headerFields, scrubber, redactedKeys),
        ...(rawSignature ? { signature: rawSignature } : {}),
        cases: rawCases
      };
      const mismatch = fileHeader.workflow.id !== target.id;
      if (mismatch && !body.data.allowWorkflowMismatch) {
        reply.code(409);
        return {
          error: `The file was exported from workflow ${fileHeader.workflow.id}, not ${target.id}. Set allowWorkflowMismatch (CLI: --allow-other-workflow) to import it anyway; only nodes whose id and type match keep their recorded outputs.`,
          code: "workflow_mismatch"
        };
      }

      const warnings: string[] = [];
      let signature: "verified" | "unverified" | "absent" = "absent";
      if (fileHeader.signature) {
        const bytes = goldenSetSignedBytes(body.data.file as Record<string, unknown>, fileHeader.signature.keyId, fileHeader.signature.signedAt);
        signature = deps.signing.verify(fileHeader.signature.keyId, bytes, fileHeader.signature.signature) ? "verified" : "unverified";
        if (signature === "unverified") {
          warnings.push(
            `The file is signed with key ${fileHeader.signature.keyId.slice(0, 16)}, which this deployment cannot verify. Everything in it was scrubbed and checked on import as for any file; verify the signature with 'l2m golden verify' and the exporting deployment's public key.`
          );
        }
      }

      // Validation, scrub and serialise, case by case, outside the transaction.
      const caseLimit = Math.min(deps.maxCaseBytes, GOLDEN_SET_CASE_MAX_BYTES);
      const keepNodes = mismatch ? new Map(target.nodes.map((node) => [node.id, node.type])) : undefined;
      const prepared: Array<{ entry: GoldenSetFileCase; recording: PreparedImport; scorers: EvalScorerSpec[] | undefined }> = [];
      const droppedNodes = new Set<string>();
      let droppedJudgeSecrets = 0;
      let droppedTapeEntries = 0;
      let total = jsonBytes({ ...fileHeader, cases: [] });
      try {
        for (const [index, rawCase] of fileHeader.cases.entries()) {
          await yieldToEventLoop();
          const parsedCase = goldenSetFileCaseSchema.safeParse(rawCase);
          if (!parsedCase.success) {
            const issue = parsedCase.error.issues[0];
            const where = ["cases", index, ...(issue?.path ?? [])].join(".");
            reply.code(400);
            return { error: `Not a valid l2m.golden-set file (${where}: ${issue?.message ?? "invalid"})`, details: parsedCase.error.issues.slice(0, 20) };
          }
          const original = parsedCase.data;
          const caseName = recordings.scrubFileValue(original.name, scrubber, redactedKeys);
          const size = jsonBytes(original);
          if (size > caseLimit) {
            reply.code(413);
            return { error: `Case ${index + 1} (${caseName}) is ${size} bytes; a case can be at most ${caseLimit} bytes.` };
          }
          total += size;
          if (total > deps.maxFileBytes) {
            reply.code(413);
            return { error: `The file is over ${deps.maxFileBytes} bytes (GOLDEN_SET_IMPORT_MAX_BYTES).` };
          }
          const claimedAt = Date.parse(original.recording.recordedAt);
          if (!Number.isFinite(claimedAt) || claimedAt < MIN_RECORDED_AT_MS) {
            reply.code(400);
            return { error: `Case ${index + 1} (${caseName}): recordedAt must be a valid ISO timestamp not before 2000-01-01.` };
          }
          // Hash check on the file as sent, then the generic deep scrub of the whole case.
          const entry = {
            ...original,
            name: caseName,
            ...(original.scorers ? { scorers: recordings.scrubFileValue(original.scorers, scrubber, redactedKeys) } : {}),
            recording: recordings.scrubFileRecording(original.recording, scrubber, redactedKeys)
          };
          const recording = recordings.prepareImport(
            { workflowId: target.id, projectId, recording: entry.recording, name: entry.recording.name, sourceWorkflowId: fileHeader.workflow.id, ...(keepNodes ? { keepNodes } : {}) },
            scrubber
          );
          for (const nodeId of recording.droppedNodes) droppedNodes.add(nodeId);
          const { scorers, dropped } = withoutJudgeSecret(entry.scorers);
          droppedJudgeSecrets += dropped;
          droppedTapeEntries += recording.droppedTapeEntries;
          prepared.push({ entry, recording, scorers });
        }
      } catch (error) {
        if (error instanceof ReplayRecordingError) {
          reply.code(RECORDING_ERROR_STATUS[error.code]);
          return { error: error.message, code: error.code };
        }
        throw error;
      }

      const name = body.data.name === undefined ? fileHeader.name : recordings.scrubFileValue(body.data.name, scrubber, redactedKeys);
      const datasetId = `ds_${randomUUID()}`;
      try {
        // Inserts only: everything expensive happened above.
        store.transaction(() => {
          store.createEvalDataset({
            id: datasetId,
            name,
            ...(fileHeader.description ? { description: fileHeader.description } : {}),
            projectId,
            workflowId: target.id,
            createdBy: user.email
          });
          for (const { entry, recording, scorers } of prepared) {
            const summary = recordings.saveImport(recording, user.email);
            store.createEvalFixture({
              id: `fix_${randomUUID()}`,
              datasetId,
              name: entry.name,
              input: recording.input ?? null,
              ...(scorers && scorers.length > 0 ? { scorers: scorers as unknown as Array<Record<string, unknown>> } : {}),
              recordingId: summary.id
            });
          }
        });
      } catch (error) {
        if (error instanceof ReplayRecordingError) {
          reply.code(RECORDING_ERROR_STATUS[error.code]);
          return { error: error.message, code: error.code };
        }
        throw error;
      }
      if (mismatch) {
        warnings.push(`The file was exported from workflow ${fileHeader.workflow.id} (${fileHeader.workflow.name || "unnamed"}); its cases were imported into ${target.id} as asked.`);
      }
      if (droppedNodes.size > 0) {
        const list = [...droppedNodes].slice(0, 20).join(", ");
        warnings.push(
          `Recorded outputs of ${droppedNodes.size} node${droppedNodes.size === 1 ? "" : "s"} were dropped because ${target.id} has no node with the same id and type: ${list}${droppedNodes.size > 20 ? ", ..." : ""}. A replay stubs those nodes without a recording.`
        );
      }
      if (droppedJudgeSecrets > 0) {
        warnings.push(`${droppedJudgeSecrets} judge scorer${droppedJudgeSecrets === 1 ? "" : "s"} lost the credential reference: attach one before running the judge.`);
      }
      if (droppedTapeEntries > 0) {
        warnings.push(`${droppedTapeEntries} recorded model call${droppedTapeEntries === 1 ? "" : "s"} were dropped because ${target.id} has no node with the same id and type; those tapes are marked truncated.`);
      }
      const dataset = store.getEvalDataset(datasetId);
      deps.audit(request, user, {
        eventType: "replay.golden_set.imported",
        category: "workflow",
        action: "create",
        resourceType: "golden_set",
        resourceId: datasetId,
        projectId,
        metadata: {
          datasetId,
          workflowId: target.id,
          sourceWorkflowId: fileHeader.workflow.id,
          workflowMismatch: mismatch,
          cases: prepared.length,
          signature,
          ...(fileHeader.signature ? { keyId: fileHeader.signature.keyId } : {}),
          droppedNodes: droppedNodes.size,
          warnings: warnings.length
        }
      });
      reply.code(201);
      return { dataset, imported: prepared.length, skipped: 0, warnings };
    }
  );
}
