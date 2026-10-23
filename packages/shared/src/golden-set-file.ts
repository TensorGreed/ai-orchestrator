import { z } from "zod";
import { AUDIT_SIGNING_ALGORITHM, canonicalJsonBytes } from "./audit-manifest";
import { evalScorerListSchema } from "./evals";

/**
 * Phase 15.5 - the golden-set file: a golden set as one JSON document that
 * can live in git, travel between deployments and be loaded by a pipeline.
 *
 *   { "format": "l2m.golden-set", "version": 1, "workflow": {id, name}, "name",
 *     "exportedAt", "exportedBy", "cases": [{ name, scorers?, recording }],
 *     "signature"? }
 *
 * Each case carries a self-contained golden run (scrubbed input, per-node
 * outputs, run facts, the MCP cassette and the workflow as it ran). A file
 * never holds secret values or secret references: the exporter strips them
 * and the importer scrubs the whole file again with the importing
 * deployment's own secrets, so a file edited by hand is not trusted.
 *
 * `scorers` are per case (a case's scorers run before the job's). A judge
 * scorer's `secretRef` is not part of the file: the importing deployment's
 * user attaches a credential there.
 *
 * Signature: an Ed25519 signature by the exporting deployment's audit key over
 * the canonical JSON of the file without its `signature` block, bound to the
 * key id and signing time. Only a public key obtained from the deployment
 * through a trusted channel proves who exported a file; checked against the
 * key embedded in the file it shows internal consistency only.
 */

export const GOLDEN_SET_FILE_FORMAT = "l2m.golden-set";
export const GOLDEN_SET_FILE_VERSION = 1;
/** The most cases one file can hold. */
export const GOLDEN_SET_FILE_MAX_CASES = 500;
/** Default cap on a whole file, in bytes (`GOLDEN_SET_FILE_MAX_BYTES` on the server). */
export const GOLDEN_SET_FILE_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Absolute ceiling on one case's recording, in bytes; a deployment's `REPLAY_RECORDING_MAX_BYTES` applies on top. */
export const GOLDEN_SET_CASE_MAX_BYTES = 32 * 1024 * 1024;

const jsonRecord = z.record(z.string(), z.unknown());
const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

const recordedRunShape = {
  status: z.string().max(80),
  output: z.unknown().optional(),
  error: z.string().nullable().optional()
};

const recordedNodeSchema = z.object({
  nodeId: z.string().min(1).max(200),
  nodeType: z.string().min(1).max(200),
  ...recordedRunShape,
  runs: z.array(z.object(recordedRunShape)).max(10_000).optional()
});

const runFactsSchema = z.object({
  status: z.string().max(80),
  error: nullableString,
  output: z.unknown(),
  nodes: z
    .array(z.object({ nodeId: z.string(), nodeType: z.string(), status: z.string(), durationMs: nullableNumber, errorCategory: nullableString }))
    .max(10_000),
  toolCalls: z
    .array(
      z.object({
        nodeId: z.string(),
        iteration: nullableNumber,
        server: z.string(),
        tool: z.string(),
        args: z.unknown(),
        argsHash: z.string(),
        outcome: z.string(),
        durationMs: nullableNumber
      })
    )
    .max(100_000),
  modelCalls: z
    .array(
      z.object({
        nodeId: z.string(),
        iteration: nullableNumber,
        providerId: z.string(),
        model: z.string(),
        inputTokens: nullableNumber,
        outputTokens: nullableNumber,
        costUsd: nullableNumber,
        latencyMs: nullableNumber
      })
    )
    .max(100_000),
  guard: z
    .array(
      z.object({
        nodeId: nullableString,
        placement: z.string(),
        channel: z.string(),
        detectorId: nullableString,
        effectiveAction: z.string(),
        shadow: z.boolean()
      })
    )
    .max(100_000),
  totals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    costUsd: nullableNumber,
    durationMs: nullableNumber,
    modelCalls: z.number(),
    toolCalls: z.number()
  })
});

export const goldenSetFileRecordingSchema = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).nullable().optional(),
  sourceTriggerType: nullableString.optional(),
  sourceStatus: z.string().min(1).max(80),
  /** Hash of the workflow as it ran (the exporting deployment's). */
  workflowHash: z.string().min(1).max(200),
  workflowSavedVersion: z.number().int().positive().nullable().optional(),
  /** The workflow as it ran, with node configurations sanitised and secret references removed. */
  workflow: jsonRecord,
  input: z.unknown().nullable(),
  nodes: z.record(z.string(), recordedNodeSchema),
  facts: runFactsSchema,
  /** The run's MCP cassette, or null when it was not recorded. Checked against the cassette format on import. */
  cassette: z.unknown().nullable(),
  /** A recorded model tape, when the exporting deployment has one. Carried as is; ignored by a deployment that has none. */
  modelTape: z.unknown().optional(),
  /** Session memory seeded at the start of the run, when the exporting deployment has it. */
  memorySeed: z.unknown().optional(),
  /** Some node outputs were cut to fit the recording size limit. */
  truncated: z.boolean().optional(),
  scrubbed: z.object({ input: z.boolean(), output: z.boolean(), nodes: z.array(z.string()) }).optional()
});
export type GoldenSetFileRecording = z.infer<typeof goldenSetFileRecordingSchema>;

export const goldenSetFileCaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  scorers: evalScorerListSchema.optional(),
  recording: goldenSetFileRecordingSchema
});
export type GoldenSetFileCase = z.infer<typeof goldenSetFileCaseSchema>;

export const goldenSetFileSignatureSchema = z.object({
  algorithm: z.literal(AUDIT_SIGNING_ALGORITHM),
  keyId: z.string().min(1).max(200),
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKey: z.string().min(1).max(200),
  signedAt: z.string().min(1).max(64),
  /** Base64 Ed25519 signature over `goldenSetSignedBytes(...)`. */
  signature: z.string().min(1).max(200)
});
export type GoldenSetFileSignature = z.infer<typeof goldenSetFileSignatureSchema>;

export const goldenSetFileSchema = z.object({
  format: z.literal(GOLDEN_SET_FILE_FORMAT),
  version: z.literal(GOLDEN_SET_FILE_VERSION),
  workflow: z.object({ id: z.string().min(1).max(200), name: z.string().max(300) }),
  /** The golden set's name. */
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  exportedAt: z.string().min(1).max(64),
  exportedBy: nullableString.optional(),
  cases: z.array(goldenSetFileCaseSchema).max(GOLDEN_SET_FILE_MAX_CASES),
  signature: goldenSetFileSignatureSchema.optional()
});
export type GoldenSetFile = z.infer<typeof goldenSetFileSchema>;

/** Body of `POST /api/eval/datasets/import`. */
export const goldenSetImportRequestSchema = z
  .object({
    file: z.unknown(),
    workflowId: z.string().trim().min(1).max(200),
    projectId: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(120).optional()
  })
  .strict();
export type GoldenSetImportRequest = z.infer<typeof goldenSetImportRequestSchema>;

/** The bytes a file signature covers: the file without its signature block, bound to the key id and signing time. */
export function goldenSetSignedBytes(file: Record<string, unknown>, keyId: string, signedAt: string): Uint8Array {
  const { signature: _signature, ...unsigned } = file;
  return canonicalJsonBytes({ file: unsigned, keyId, signedAt });
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? "null").length;

/**
 * The first size problem of a parsed file, or null: too many cases, a case
 * over the per-case cap, or the whole file over the total cap.
 */
export function goldenSetFileSizeProblem(file: GoldenSetFile, limits: { maxBytes: number; maxCaseBytes: number; maxCases?: number }): string | null {
  const maxCases = Math.min(limits.maxCases ?? GOLDEN_SET_FILE_MAX_CASES, GOLDEN_SET_FILE_MAX_CASES);
  if (file.cases.length > maxCases) return `The file has ${file.cases.length} cases; at most ${maxCases} can be imported.`;
  let total = byteLength({ ...file, cases: [] });
  for (const [index, entry] of file.cases.entries()) {
    const size = byteLength(entry);
    if (size > limits.maxCaseBytes) return `Case ${index + 1} (${entry.name}) is ${size} bytes; a case can be at most ${limits.maxCaseBytes} bytes.`;
    total += size;
    if (total > limits.maxBytes) return `The file is over ${limits.maxBytes} bytes.`;
  }
  return null;
}

const SECRET_REFERENCE_KEY = /^(secretId|secretRef|.*SecretId|.*SecretRef)$/;

/**
 * A copy of a value without secret references: every `secretRef`, `secretId`
 * and `...SecretRef` / `...SecretId` key, at any depth, is removed.
 */
export function stripSecretReferences<T>(value: T): T {
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 64) return null;
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, inner] of Object.entries(node as Record<string, unknown>)) {
        if (SECRET_REFERENCE_KEY.test(key)) continue;
        out[key] = walk(inner, depth + 1);
      }
      return out;
    }
    return node;
  };
  return walk(value, 0) as T;
}
