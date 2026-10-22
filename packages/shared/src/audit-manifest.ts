import { z } from "zod";

/**
 * Phase 11.1 — signed run manifests and audit bundles.
 *
 * A run manifest is a versioned, canonical JSON record of one finished
 * execution: the workflow version that ran (with a stable hash), every
 * node's configuration with secrets as references only, input and output
 * digests instead of payloads, model calls, MCP tool calls with server
 * identity and schema snapshot hashes, prompts, RAG citations, approvals,
 * and token and cost totals. The API builds it from what the run recorded,
 * caches it per execution and signs it with the deployment's Ed25519 key.
 *
 * An audit bundle is a zip of the manifest, the node I/O and trace the run
 * stored (already redacted), logs, rendered outputs, a README and
 * `signature.json`: a signed index of every other file's SHA-256 digest,
 * so a change to any file in the bundle is detected offline with
 * `l2m audit verify`.
 *
 * This module is self-contained and runs in the browser and in Node: it
 * holds the schemas, the canonical serialisation and the exact bytes that
 * get signed. Hashing and signing happen in the caller (node:crypto).
 */

export const RUN_MANIFEST_FORMAT = "l2m.run-manifest";
export const RUN_MANIFEST_VERSION = 1;
export const RUN_MANIFEST_ATTESTATION_FORMAT = "l2m.run-manifest-attestation";
export const AUDIT_BUNDLE_SIGNATURE_FORMAT = "l2m.audit-bundle-signature";
export const AUDIT_BUNDLE_SIGNATURE_VERSION = 1;
export const AUDIT_SIGNING_ALGORITHM = "Ed25519";

/** Fixed paths inside an audit bundle. */
export const AUDIT_BUNDLE_MANIFEST_PATH = "manifest.json";
export const AUDIT_BUNDLE_SIGNATURE_PATH = "signature.json";
export const AUDIT_BUNDLE_README_PATH = "README.txt";

/** Hex characters of SHA-256(raw public key) that make a key id. */
export const AUDIT_KEY_ID_HEX_CHARS = 16;

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, `undefined`
 * object members dropped, no whitespace, strings and numbers as
 * `JSON.stringify` writes them (shortest round-trip numbers, `-0` as `0`,
 * non-ASCII characters kept as UTF-8, lone surrogates escaped). This is the
 * same sorted-key approach as the guard profile hash and the MCP cassette
 * argument hash, so equal values always produce identical bytes.
 * Non-finite numbers have no JSON form and are refused rather than
 * silently written as `null`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set()));
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite numbers have no JSON form");
    return value;
  }
  if (typeof value === "bigint") throw new TypeError("canonicalJson: bigint values have no JSON form");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("canonicalJson: circular structure");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") return canonicalValue((toJson as () => unknown).call(value), seen);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined || typeof inner === "function" || typeof inner === "symbol") continue;
      out[key] = canonicalValue(inner, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** UTF-8 bytes of the canonical JSON of `value`. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

// ---------------------------------------------------------------------------
// Manifest schema (version 1)
// ---------------------------------------------------------------------------

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase hex SHA-256 digest");
const isoTime = z.string().min(1);
const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

/** How a tool call ended. Refused calls never reached the server. */
export const RUN_MANIFEST_TOOL_OUTCOMES = [
  "ok",
  "error",
  "policy_blocked",
  "guard_blocked",
  "rate_limited",
  "concurrency_limited",
  "breaker_rejected"
] as const;
export type RunManifestToolOutcome = (typeof RUN_MANIFEST_TOOL_OUTCOMES)[number];

export const runManifestNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  /** `not_run` for nodes of the workflow that have no result in this run. */
  status: z.string(),
  startedAt: nullableString,
  completedAt: nullableString,
  durationMs: nullableNumber,
  attempts: nullableNumber,
  errorCategory: nullableString,
  /** The node's configuration as it ran: secrets appear only as `secretRef.secretId`, secret-looking literals as `[REDACTED]`. */
  config: z.record(z.string(), z.unknown()),
  /** SHA-256 of the canonical JSON of the node input / output as stored in execution history; null when none was stored. */
  inputDigest: sha256Hex.nullable(),
  outputDigest: sha256Hex.nullable()
});

export const runManifestModelCallSchema = z.object({
  nodeId: z.string(),
  /** Agent loop iteration; null for a single model call node. */
  iteration: nullableNumber,
  providerId: z.string(),
  model: z.string(),
  /** Generation parameters (temperature, max tokens, …) without credentials or endpoints' secrets. */
  parameters: z.record(z.string(), z.unknown()),
  inputTokens: nullableNumber,
  outputTokens: nullableNumber,
  cachedInputTokens: nullableNumber,
  /** USD estimate from the deployment's price table; null when the model is not priced. */
  costUsd: nullableNumber,
  latencyMs: nullableNumber
});

export const runManifestToolCallSchema = z.object({
  nodeId: z.string(),
  iteration: nullableNumber,
  toolCallId: nullableString,
  toolName: z.string(),
  adapterId: nullableString,
  registryServerId: nullableString,
  /** `catalog:<entry>@<package>`, `package:<spec>`, `url:<endpoint without credentials or query>` or `adapter:<id>`. */
  serverIdentity: nullableString,
  schemaSnapshotHash: nullableString,
  argsDigest: sha256Hex.nullable(),
  resultDigest: sha256Hex.nullable(),
  outcome: z.enum(RUN_MANIFEST_TOOL_OUTCOMES),
  startedAt: nullableString,
  durationMs: nullableNumber
});

export const runManifestMcpServerSchema = z.object({
  registryServerId: z.string(),
  name: z.string(),
  adapterId: z.string(),
  transport: z.enum(["http", "stdio", "other"]),
  /** HTTP endpoint without user info, query or fragment. */
  url: nullableString,
  package: z
    .object({ runner: z.string(), spec: z.string(), pinned: z.boolean() })
    .nullable(),
  catalogEntryId: nullableString,
  snapshotId: nullableString,
  snapshotHash: nullableString
});

export const runManifestPromptSchema = z.object({
  nodeId: z.string(),
  role: z.enum(["system", "user"]),
  template: nullableString,
  rendered: nullableString
});

export const runManifestCitationSchema = z.object({
  nodeId: z.string(),
  marker: nullableString,
  index: nullableNumber,
  chunkId: nullableString,
  sourceId: nullableString,
  knowledgeBaseId: nullableString,
  score: nullableNumber,
  retrievalMode: nullableString,
  /** SHA-256 of the cited text; the text itself stays in the node output. */
  textDigest: sha256Hex.nullable()
});

export const runManifestApprovalSchema = z.object({
  nodeId: z.string(),
  decision: z.enum(["approve", "reject"]),
  actedBy: nullableString,
  reason: nullableString,
  decidedAt: nullableString
});

/** Phase 12.7 — one guard verdict row of the run (no matched content, no token-vault values). */
export const runManifestGuardVerdictSchema = z.object({
  verdictId: z.string(),
  nodeId: z.string(),
  channel: z.string(),
  placement: z.string(),
  iteration: nullableNumber,
  toolName: nullableString,
  detectorId: nullableString,
  category: nullableString,
  requestedAction: z.string(),
  effectiveAction: z.string(),
  verdictAction: z.string(),
  shadow: z.boolean(),
  profileId: z.string(),
  profileVersion: z.number(),
  profileHash: z.string()
});

export const runManifestGuardExtensionSchema = z.object({
  verdicts: z.array(runManifestGuardVerdictSchema),
  summary: z.object({
    verdicts: z.number(),
    findings: z.number(),
    blocked: z.number(),
    byAction: z.record(z.string(), z.number())
  })
});

/**
 * Typed, optional extensions. Known keys are validated; other keys are kept
 * as-is so a newer deployment's additions (for example approval-gate
 * decisions from Phase 11.2) do not break older verifiers.
 *
 *   - `guard` — the run's guard verdicts (Phase 12.7).
 */
export const runManifestExtensionsSchema = z
  .object({
    guard: runManifestGuardExtensionSchema.optional()
  })
  .catchall(z.unknown());

export const runManifestSchema = z.object({
  format: z.literal(RUN_MANIFEST_FORMAT),
  manifestVersion: z.literal(RUN_MANIFEST_VERSION),
  generatedAt: isoTime,
  deployment: z.object({
    keyId: z.string(),
    algorithm: z.literal(AUDIT_SIGNING_ALGORITHM)
  }),
  run: z.object({
    executionId: z.string(),
    status: z.string(),
    triggerType: nullableString,
    /** Who or what started the run, as execution history recorded it. */
    subject: nullableString,
    startedAt: isoTime,
    completedAt: isoTime,
    durationMs: nullableNumber,
    error: nullableString,
    inputDigest: sha256Hex.nullable(),
    outputDigest: sha256Hex.nullable()
  }),
  workflow: z.object({
    id: z.string(),
    name: nullableString,
    schemaVersion: nullableString,
    workflowVersion: nullableNumber,
    /** Saved version number whose content matches this hash, when one exists. */
    savedVersion: nullableNumber,
    /** SHA-256 of the canonical JSON of the workflow definition (secret-looking literals redacted, timestamps left out). */
    hash: sha256Hex,
    /** `captured`: recorded when the run finished; `current`: the stored definition at manifest time (older runs). */
    source: z.enum(["captured", "current", "unavailable"]),
    nodeCount: z.number(),
    edgeCount: z.number()
  }),
  nodes: z.array(runManifestNodeSchema),
  modelCalls: z.array(runManifestModelCallSchema),
  toolCalls: z.array(runManifestToolCallSchema),
  mcpServers: z.array(runManifestMcpServerSchema),
  prompts: z.array(runManifestPromptSchema),
  citations: z.array(runManifestCitationSchema),
  approvals: z.array(runManifestApprovalSchema),
  totals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number(),
    totalTokens: z.number(),
    costUsd: nullableNumber,
    modelCalls: z.number(),
    toolCalls: z.number()
  }),
  extensions: runManifestExtensionsSchema.optional()
});

export type RunManifest = z.infer<typeof runManifestSchema>;
export type RunManifestNode = z.infer<typeof runManifestNodeSchema>;
export type RunManifestModelCall = z.infer<typeof runManifestModelCallSchema>;
export type RunManifestToolCall = z.infer<typeof runManifestToolCallSchema>;
export type RunManifestMcpServer = z.infer<typeof runManifestMcpServerSchema>;
export type RunManifestPrompt = z.infer<typeof runManifestPromptSchema>;
export type RunManifestCitation = z.infer<typeof runManifestCitationSchema>;
export type RunManifestApproval = z.infer<typeof runManifestApprovalSchema>;
export type RunManifestGuardVerdict = z.infer<typeof runManifestGuardVerdictSchema>;
export type RunManifestGuardExtension = z.infer<typeof runManifestGuardExtensionSchema>;

// ---------------------------------------------------------------------------
// Bundle signature
// ---------------------------------------------------------------------------

export const auditBundleIndexEntrySchema = z.object({
  path: z.string().min(1),
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative()
});

export const auditBundleIndexSchema = z.object({
  executionId: z.string(),
  workflowId: z.string(),
  manifestDigest: sha256Hex,
  /** Every file in the bundle except `signature.json`, sorted by path. */
  files: z.array(auditBundleIndexEntrySchema)
});

export const auditBundleSignatureSchema = z.object({
  format: z.literal(AUDIT_BUNDLE_SIGNATURE_FORMAT),
  version: z.literal(AUDIT_BUNDLE_SIGNATURE_VERSION),
  algorithm: z.literal(AUDIT_SIGNING_ALGORITHM),
  keyId: z.string().min(1),
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKey: z.string().min(1),
  signedAt: isoTime,
  index: auditBundleIndexSchema,
  /** Base64 Ed25519 signature over `auditBundleSignedBytes(...)`. */
  signature: z.string().min(1)
});

export type AuditBundleIndexEntry = z.infer<typeof auditBundleIndexEntrySchema>;
export type AuditBundleIndex = z.infer<typeof auditBundleIndexSchema>;
export type AuditBundleSignature = z.infer<typeof auditBundleSignatureSchema>;

/** The exact bytes a bundle signature covers: everything in `signature.json` except the signature itself. */
export function auditBundleSignedBytes(input: Omit<AuditBundleSignature, "signature">): Uint8Array {
  return canonicalJsonBytes({
    format: input.format,
    version: input.version,
    algorithm: input.algorithm,
    keyId: input.keyId,
    publicKey: input.publicKey,
    signedAt: input.signedAt,
    index: input.index
  });
}

/** The exact bytes a manifest attestation (the API's per-manifest signature) covers. */
export function runManifestAttestationBytes(input: { executionId: string; manifestDigest: string; keyId: string; signedAt: string }): Uint8Array {
  return canonicalJsonBytes({
    format: RUN_MANIFEST_ATTESTATION_FORMAT,
    executionId: input.executionId,
    manifestDigest: input.manifestDigest,
    keyId: input.keyId,
    signedAt: input.signedAt
  });
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

/** `GET /api/executions/:id/manifest`. */
export interface RunManifestView {
  executionId: string;
  manifest: RunManifest;
  /** SHA-256 (hex) of the manifest's canonical bytes, i.e. of `manifest.json` in a bundle. */
  digest: string;
  keyId: string;
  algorithm: typeof AUDIT_SIGNING_ALGORITHM;
  /** When the manifest was generated and signed; it never changes afterwards. */
  signedAt: string;
  /** Base64 Ed25519 signature over `runManifestAttestationBytes`. */
  signature: string;
}

/** One deployment signing key; only public material is ever returned. */
export interface AuditSigningKeyView {
  keyId: string;
  algorithm: typeof AUDIT_SIGNING_ALGORITHM;
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
  publicKeyPem: string;
  /** `env`: AUDIT_SIGNING_KEY_BASE64; `generated`: created by the API and stored encrypted. */
  source: "env" | "generated";
  status: "active" | "retired";
  createdAt: string;
  retiredAt: string | null;
}

export interface AuditSigningKeysResponse {
  activeKeyId: string;
  /** False when the key comes from AUDIT_SIGNING_KEY_BASE64 (rotate by changing the variable). */
  canRotate: boolean;
  keys: AuditSigningKeyView[];
}
