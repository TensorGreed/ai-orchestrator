/**
 * Phase 11.1 — offline verification of an L2M audit bundle.
 *
 * Checks, with no network and no server:
 *   - the archive is a well-formed ZIP (no truncation, no duplicate or unsafe names);
 *   - `signature.json` is present and well-formed, and its key id matches its public key;
 *   - the Ed25519 signature over the signed index verifies, with the public key
 *     given on the command line or, failing that, the one inside the bundle;
 *   - every file matches the SHA-256 digest and size in the signed index, and no
 *     file was added or removed;
 *   - `manifest.json` hashes to the signed manifest digest, is a valid manifest
 *     and names the same execution and workflow as the index;
 *   - `workflow.json`, when present, hashes to the manifest's workflow hash.
 *
 * Only a public key obtained from the deployment through a trusted channel
 * proves who signed a bundle. Checked against the key embedded in the
 * bundle, the result shows internal consistency only: whoever changes a
 * bundle can re-sign it with a key of their own and embed that key. Such a
 * result is never a pass unless the caller explicitly trusts the embedded key.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { inflateRawSync } from "node:zlib";
import {
  AUDIT_BUNDLE_MANIFEST_PATH,
  DEFAULT_ZIP_MAX_TOTAL_BYTES,
  AUDIT_BUNDLE_SIGNATURE_PATH,
  AUDIT_KEY_ID_HEX_CHARS,
  auditBundleSignatureSchema,
  auditBundleSignedBytes,
  canonicalJson,
  readZip,
  runManifestSchema,
  type AuditBundleSignature,
  type RunManifest
} from "@ai-orchestrator/shared";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface AuditVerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type AuditVerifyStatus = "pass" | "fail" | "signer_unverified";

export interface AuditVerifyResult {
  /**
   * True only when every check passed and the signer is verified (a trusted
   * public key was given), or the caller explicitly trusted the embedded key.
   */
  ok: boolean;
  status: AuditVerifyStatus;
  /** Every check passed (signature, file digests, manifest), whatever key was used. */
  integrityOk: boolean;
  /** The signature verified with a public key given by the caller, not the one inside the bundle. */
  signerVerified: boolean;
  /** The caller passed --trust-embedded-key. */
  embeddedKeyTrusted: boolean;
  bundle: string;
  keyId: string | null;
  /** Where the public key used for the signature check came from. */
  keySource: "provided" | "bundle" | null;
  signedAt: string | null;
  manifestDigest: string | null;
  executionId: string | null;
  workflowId: string | null;
  workflowName: string | null;
  runStatus: string | null;
  completedAt: string | null;
  files: number;
  checks: AuditVerifyCheck[];
  warnings: string[];
}

export class PublicKeyInputError extends Error {}

function sha256(data: Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function keyIdForPublicKey(raw: Uint8Array): string {
  return sha256(raw).slice(0, AUDIT_KEY_ID_HEX_CHARS);
}

function publicKeyObject(raw: Uint8Array): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
}

function rawFromKeyObject(key: crypto.KeyObject): Buffer {
  if (key.asymmetricKeyType !== "ed25519") throw new PublicKeyInputError("The public key is not an Ed25519 key");
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

/**
 * A public key from `--public-key`: a file or an inline value holding a PEM
 * public key, the base64 of the raw 32-byte key, or the base64 of its SPKI DER.
 */
export function parsePublicKeyInput(value: string): Buffer {
  let text = value.trim();
  if (!text) throw new PublicKeyInputError("--public-key is empty");
  const looksInline = text.includes("BEGIN PUBLIC KEY") || /^[A-Za-z0-9+/]{43}=$/.test(text) || /^[A-Za-z0-9+/]{59}=$/.test(text);
  if (!looksInline) {
    try {
      text = fs.readFileSync(text, "utf8").trim();
    } catch (error) {
      throw new PublicKeyInputError(`Cannot read the public key file ${value}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (text.includes("BEGIN PUBLIC KEY")) {
    try {
      return rawFromKeyObject(crypto.createPublicKey({ key: text, format: "pem" }));
    } catch (error) {
      if (error instanceof PublicKeyInputError) throw error;
      throw new PublicKeyInputError("The PEM public key cannot be read");
    }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new PublicKeyInputError("The public key must be PEM or base64");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 32) return bytes;
  if (bytes.length === SPKI_ED25519_PREFIX.length + 32 && bytes.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)) {
    return Buffer.from(bytes.subarray(SPKI_ED25519_PREFIX.length));
  }
  throw new PublicKeyInputError("The public key must be a 32-byte Ed25519 key (base64) or a PEM public key");
}

export const EMBEDDED_KEY_WARNING =
  "SIGNER NOT VERIFIED: no --public-key was given, so the signature was checked against the key embedded in the bundle. " +
  "That only shows the bundle is internally consistent: anyone who changes a bundle can re-sign it with their own key. " +
  "It proves neither who signed it nor that it is unchanged since the server signed it. Pass the deployment's public key.";

export interface AuditVerifyOptions {
  bundle?: string;
  /** The deployment's public key, obtained through a trusted channel. */
  publicKey?: Uint8Array;
  /** Accept a bundle checked only against its embedded key (internal consistency). */
  trustEmbeddedKey?: boolean;
  /** Largest total expanded size accepted (default 512 MiB). */
  maxBytes?: number;
}

export function verifyAuditBundle(bytes: Uint8Array, options: AuditVerifyOptions = {}): AuditVerifyResult {
  const result: AuditVerifyResult = {
    ok: false,
    status: "fail",
    integrityOk: false,
    signerVerified: false,
    embeddedKeyTrusted: Boolean(options.trustEmbeddedKey),
    bundle: options.bundle ?? "bundle",
    keyId: null,
    keySource: null,
    signedAt: null,
    manifestDigest: null,
    executionId: null,
    workflowId: null,
    workflowName: null,
    runStatus: null,
    completedAt: null,
    files: 0,
    checks: [],
    warnings: []
  };
  const check = (name: string, ok: boolean, detail: string) => {
    result.checks.push({ name, ok, detail });
    return ok;
  };
  const finish = () => {
    result.integrityOk = result.checks.length > 0 && result.checks.every((entry) => entry.ok);
    result.signerVerified = result.integrityOk && result.keySource === "provided";
    result.ok = result.signerVerified || (result.integrityOk && result.embeddedKeyTrusted);
    result.status = !result.integrityOk ? "fail" : result.signerVerified ? "pass" : "signer_unverified";
    return result;
  };

  // 1. Archive.
  let files: Map<string, Buffer>;
  try {
    const entries = readZip(bytes, {
      inflateRaw: (data, expected) => new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, expected) })),
      maxTotalBytes: options.maxBytes ?? DEFAULT_ZIP_MAX_TOTAL_BYTES
    });
    files = new Map(entries.map((entry) => [entry.path, Buffer.from(entry.data)]));
  } catch (error) {
    check("archive", false, `not a readable ZIP archive: ${error instanceof Error ? error.message : String(error)}`);
    return finish();
  }
  check("archive", true, `${files.size} entries, well-formed`);

  // 2. Signature file.
  const signatureBytes = files.get(AUDIT_BUNDLE_SIGNATURE_PATH);
  if (!signatureBytes) {
    check("signature file", false, `${AUDIT_BUNDLE_SIGNATURE_PATH} is missing`);
    return finish();
  }
  let signature: AuditBundleSignature;
  try {
    signature = auditBundleSignatureSchema.parse(JSON.parse(signatureBytes.toString("utf8")));
  } catch {
    check("signature file", false, `${AUDIT_BUNDLE_SIGNATURE_PATH} is not a valid signature file`);
    return finish();
  }
  result.keyId = signature.keyId;
  result.signedAt = signature.signedAt;
  result.manifestDigest = signature.index.manifestDigest;
  result.executionId = signature.index.executionId;
  result.workflowId = signature.index.workflowId;
  const embedded = Buffer.from(signature.publicKey, "base64");
  if (embedded.length !== 32 || keyIdForPublicKey(embedded) !== signature.keyId) {
    check("signature file", false, `the key id ${signature.keyId} does not match the public key in the bundle`);
    return finish();
  }
  check("signature file", true, `${signature.algorithm}, key ${signature.keyId}, signed ${signature.signedAt}`);

  // 3. Signature.
  let key = embedded;
  if (options.publicKey) {
    const provided = Buffer.from(options.publicKey);
    result.keySource = "provided";
    const providedId = keyIdForPublicKey(provided);
    if (providedId !== signature.keyId) {
      check("signature", false, `signed by key ${signature.keyId}, but the public key given is ${providedId}`);
      return finish();
    }
    key = provided;
  } else {
    result.keySource = "bundle";
    result.warnings.push(EMBEDDED_KEY_WARNING);
  }
  const { signature: signatureValue, ...signedBody } = signature;
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, Buffer.from(auditBundleSignedBytes(signedBody)), publicKeyObject(key), Buffer.from(signatureValue, "base64"));
  } catch {
    signatureOk = false;
  }
  if (!check("signature", signatureOk, signatureOk ? `valid Ed25519 signature by key ${signature.keyId}` : "the signature does not match the signed index")) return finish();

  // 4. Files against the signed index.
  const problems: string[] = [];
  const indexed = new Set<string>();
  for (const entry of signature.index.files) {
    if (indexed.has(entry.path)) problems.push(`listed twice: ${entry.path}`);
    indexed.add(entry.path);
    if (entry.path === AUDIT_BUNDLE_SIGNATURE_PATH) {
      problems.push(`${AUDIT_BUNDLE_SIGNATURE_PATH} cannot be in its own index`);
      continue;
    }
    const data = files.get(entry.path);
    if (!data) problems.push(`missing: ${entry.path}`);
    else if (data.length !== entry.bytes || sha256(data) !== entry.sha256) problems.push(`modified: ${entry.path}`);
  }
  for (const name of files.keys()) {
    if (name !== AUDIT_BUNDLE_SIGNATURE_PATH && !indexed.has(name)) problems.push(`not in the signed index: ${name}`);
  }
  result.files = signature.index.files.length;
  if (!check("files", problems.length === 0, problems.length === 0 ? `${signature.index.files.length} files match the signed index` : problems.join("; "))) return finish();

  // 5. Manifest.
  const manifestBytes = files.get(AUDIT_BUNDLE_MANIFEST_PATH);
  if (!manifestBytes || !indexed.has(AUDIT_BUNDLE_MANIFEST_PATH)) {
    check("manifest", false, `${AUDIT_BUNDLE_MANIFEST_PATH} is missing`);
    return finish();
  }
  const digest = sha256(manifestBytes);
  if (!check("manifest digest", digest === signature.index.manifestDigest, digest === signature.index.manifestDigest ? `sha256 ${digest}` : `manifest.json hashes to ${digest}, the signed digest is ${signature.index.manifestDigest}`)) return finish();
  let manifest: RunManifest;
  try {
    manifest = runManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  } catch {
    check("manifest", false, "manifest.json is not a valid run manifest");
    return finish();
  }
  result.workflowName = manifest.workflow.name;
  result.runStatus = manifest.run.status;
  result.completedAt = manifest.run.completedAt;
  const sameRun = manifest.run.executionId === signature.index.executionId && manifest.workflow.id === signature.index.workflowId;
  if (!check("manifest", sameRun, sameRun ? `run ${manifest.run.executionId} of workflow ${manifest.workflow.id}` : "the manifest names a different execution or workflow than the signed index")) return finish();
  if (canonicalJson(JSON.parse(manifestBytes.toString("utf8"))) !== manifestBytes.toString("utf8")) {
    result.warnings.push("manifest.json is not in canonical form.");
  }
  if (manifest.deployment.keyId !== signature.keyId) {
    result.warnings.push(`The manifest was generated under key ${manifest.deployment.keyId}; this bundle was signed later by key ${signature.keyId} (the key was rotated).`);
  }

  // 6. Workflow definition, when included.
  const workflowBytes = files.get("workflow.json");
  if (workflowBytes) {
    let workflowHash: string | null = null;
    try {
      workflowHash = sha256(canonicalJson(JSON.parse(workflowBytes.toString("utf8"))));
    } catch {
      workflowHash = null;
    }
    check("workflow", workflowHash === manifest.workflow.hash, workflowHash === manifest.workflow.hash ? `workflow.json matches hash ${manifest.workflow.hash.slice(0, 16)}…` : "workflow.json does not match the manifest's workflow hash");
  }
  return finish();
}

export function formatAuditVerifyResult(result: AuditVerifyResult): string {
  const lines: string[] = [];
  const headline =
    result.status === "fail"
      ? "FAIL"
      : result.status === "pass"
        ? "PASS"
        : result.embeddedKeyTrusted
          ? "PASS (embedded key trusted: SIGNER NOT VERIFIED)"
          : "SIGNER NOT VERIFIED (internally consistent; no trusted public key given)";
  lines.push(`${headline}  ${result.bundle}`);
  const field = (label: string, value: string | null | undefined) => {
    if (value) lines.push(`  ${label.padEnd(11)} ${value}`);
  };
  field("Execution", result.executionId);
  field("Workflow", result.workflowId ? `${result.workflowId}${result.workflowName ? ` (${result.workflowName})` : ""}` : null);
  field("Run status", result.runStatus ? `${result.runStatus}${result.completedAt ? `, finished ${result.completedAt}` : ""}` : null);
  field("Manifest", result.manifestDigest ? `sha256 ${result.manifestDigest}` : null);
  field("Key id", result.keyId ? `${result.keyId} (${result.keySource === "provided" ? "public key given" : "public key from the bundle, not trusted"})` : null);
  field("Signed at", result.signedAt);
  lines.push("");
  for (const entry of result.checks) lines.push(`  ${entry.ok ? "ok  " : "FAIL"}  ${entry.name.padEnd(16)} ${entry.detail}`);
  for (const warning of result.warnings) lines.push(`  ${warning === EMBEDDED_KEY_WARNING ? "WARNING" : "note"}  ${warning}`);
  return `${lines.join("\n")}\n`;
}
