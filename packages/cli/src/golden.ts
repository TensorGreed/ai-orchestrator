/**
 * `l2m golden export|import|verify`: golden-set files (`l2m.golden-set` v1,
 * packages/shared golden-set-file.ts).
 *
 * Exit codes: 0 ok, 1 a request failed or a signature did not verify, 2
 * usage (also a file or flags the API rejects with 400), 3 `verify` found a
 * consistent signature but no trusted public key was given.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { goldenSetFileSchema, goldenSetSignedBytes, type GoldenSetFile } from "@ai-orchestrator/shared";
import { apiCall, apiTarget, cleanServerText, isObject, readJsonFile, replyError, RequestError, write, type CliIo } from "./api";
import { oneFlag, UsageError, type ParsedArgs } from "./args";
import { keyIdForPublicKey, parsePublicKeyInput, PublicKeyInputError } from "./audit-verify";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_SIGNER_UNVERIFIED = 3;

/** Refuse to read files larger than this into memory. */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface GoldenVerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GoldenVerifyResult {
  ok: boolean;
  status: "pass" | "fail" | "signer_unverified";
  keyId: string | null;
  signedAt: string | null;
  keySource: "provided" | "file" | null;
  cases: number;
  checks: GoldenVerifyCheck[];
  warnings: string[];
}

export const GOLDEN_EMBEDDED_KEY_WARNING =
  "SIGNER NOT VERIFIED: no --public-key was given, so the signature was checked against the key inside the file. " +
  "That only shows the file is internally consistent: anyone who edits a file can re-sign it with their own key. Pass the deployment's public key.";

/** Checks the signature of a golden-set file against a public key obtained from the deployment, or only for consistency. */
export function verifyGoldenSetFile(raw: unknown, options: { publicKey?: Uint8Array; trustEmbeddedKey?: boolean } = {}): GoldenVerifyResult {
  const checks: GoldenVerifyCheck[] = [];
  const warnings: string[] = [];
  const result = (status: GoldenVerifyResult["status"], extra: Partial<GoldenVerifyResult> = {}): GoldenVerifyResult => ({
    ok: status === "pass",
    status,
    keyId: null,
    signedAt: null,
    keySource: null,
    cases: 0,
    checks,
    warnings,
    ...extra
  });
  const parsed = goldenSetFileSchema.safeParse(raw);
  if (!parsed.success) {
    checks.push({ name: "format", ok: false, detail: `not a valid l2m.golden-set file (${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message ?? "invalid"})` });
    return result("fail");
  }
  const file: GoldenSetFile = parsed.data;
  checks.push({ name: "format", ok: true, detail: `l2m.golden-set v${file.version}, ${file.cases.length} case${file.cases.length === 1 ? "" : "s"}` });
  const signature = file.signature;
  if (!signature) {
    checks.push({ name: "signature", ok: false, detail: "the file is not signed" });
    return result("fail", { cases: file.cases.length });
  }
  const base = { keyId: signature.keyId, signedAt: signature.signedAt, cases: file.cases.length };
  let embedded: Buffer;
  try {
    embedded = Buffer.from(signature.publicKey, "base64");
    if (embedded.length !== 32) throw new Error("not 32 bytes");
  } catch {
    checks.push({ name: "signature", ok: false, detail: "the embedded public key is not a 32-byte Ed25519 key" });
    return result("fail", base);
  }
  const idMatches = keyIdForPublicKey(embedded) === signature.keyId;
  checks.push({ name: "key id", ok: idMatches, detail: idMatches ? `key ${signature.keyId} matches the embedded public key` : "the key id does not match the embedded public key" });
  if (!idMatches) return result("fail", base);
  const key = options.publicKey ?? embedded;
  if (options.publicKey && keyIdForPublicKey(options.publicKey) !== signature.keyId) {
    checks.push({ name: "signer", ok: false, detail: `the file was signed with key ${signature.keyId}, not the key given (${keyIdForPublicKey(options.publicKey)})` });
    return result("fail", { ...base, keySource: "provided" });
  }
  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(goldenSetSignedBytes(raw as Record<string, unknown>, signature.keyId, signature.signedAt)),
      crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key)]), format: "der", type: "spki" }),
      Buffer.from(signature.signature, "base64")
    );
  } catch {
    valid = false;
  }
  checks.push({ name: "signature", ok: valid, detail: valid ? "the Ed25519 signature covers the file as it is" : "the signature does not match the file: it was changed after signing" });
  if (!valid) return result("fail", { ...base, keySource: options.publicKey ? "provided" : "file" });
  if (options.publicKey) return result("pass", { ...base, keySource: "provided" });
  if (options.trustEmbeddedKey) return result("pass", { ...base, keySource: "file" });
  warnings.push(GOLDEN_EMBEDDED_KEY_WARNING);
  return result("signer_unverified", { ...base, keySource: "file" });
}

function formatVerify(result: GoldenVerifyResult, file: string): string {
  const lines = [`${result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SIGNER NOT VERIFIED"}  ${file}`];
  for (const check of result.checks) lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  for (const warning of result.warnings) lines.push(`  ${warning}`);
  return lines.join("\n");
}

function publicKeyFlag(args: ParsedArgs): Buffer | undefined {
  const flag = oneFlag(args, "public-key");
  if (flag === undefined) return undefined;
  try {
    return parsePublicKeyInput(flag);
  } catch (error) {
    if (error instanceof PublicKeyInputError) throw new UsageError(error.message);
    throw error;
  }
}

/** A file read as JSON, refusing one too large to read into memory. */
function readFileJson(file: string): unknown {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) throw new UsageError(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readJsonFile(file);
}

// --- verify ------------------------------------------------------------------

export function runGoldenVerify(args: ParsedArgs, io: CliIo): number {
  const [, , file, extra] = args.positionals;
  if (!file || extra) throw new UsageError("l2m golden verify needs exactly one golden-set file");
  const publicKey = publicKeyFlag(args);
  const trustEmbeddedKey = args.booleans.has("trust-embedded-key");
  if (trustEmbeddedKey && publicKey) throw new UsageError("--trust-embedded-key and --public-key cannot be combined");
  const result = verifyGoldenSetFile(readFileJson(file), { ...(publicKey ? { publicKey } : {}), trustEmbeddedKey });
  if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else write(io.stdout, formatVerify(result, file));
  if (result.status === "fail") return EXIT_FAILED;
  if (result.status === "signer_unverified") return EXIT_SIGNER_UNVERIFIED;
  return EXIT_OK;
}

// --- export ------------------------------------------------------------------

export async function runGoldenExport(args: ParsedArgs, io: CliIo): Promise<number> {
  const [, , datasetId, extra] = args.positionals;
  if (!datasetId || extra) throw new UsageError("l2m golden export needs exactly one golden set id");
  const out = oneFlag(args, "out");
  const sign = args.booleans.has("sign");
  const target = apiTarget(args, io);
  let reply;
  try {
    reply = await apiCall(target, "GET", `/api/eval/datasets/${encodeURIComponent(datasetId)}/export${sign ? "?sign=true" : ""}`);
  } catch (error) {
    if (error instanceof RequestError) {
      write(io.stderr, `l2m: export failed: ${cleanServerText(error.message)}`);
      return EXIT_FAILED;
    }
    throw error;
  }
  if (!reply.ok) {
    write(io.stderr, `l2m: export failed with ${reply.status}: ${cleanServerText(replyError(reply))}`);
    return EXIT_FAILED;
  }
  const parsed = goldenSetFileSchema.safeParse(reply.body);
  if (!parsed.success) {
    write(io.stderr, "l2m: export failed: the API's answer is not a golden-set file (is the CLI the same version as the API?)");
    return EXIT_FAILED;
  }
  if (sign && !parsed.data.signature) {
    write(io.stderr, "l2m: export failed: --sign was asked for but the file came back unsigned");
    return EXIT_FAILED;
  }
  const text = `${JSON.stringify(reply.body, null, 2)}\n`;
  if (out) {
    try {
      fs.writeFileSync(out, text);
    } catch (error) {
      write(io.stderr, `l2m: cannot write ${out}: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_FAILED;
    }
  } else {
    io.stdout.write(text);
  }
  const skipped = Number(reply.headers.get("x-l2m-skipped-cases") ?? 0);
  write(
    io.stderr,
    `Exported ${parsed.data.cases.length} case${parsed.data.cases.length === 1 ? "" : "s"} of '${cleanServerText(parsed.data.name)}'${parsed.data.signature ? ` (signed, key ${cleanServerText(parsed.data.signature.keyId)})` : ""}${out ? ` to ${out}` : ""}` +
      `${skipped > 0 ? `; ${skipped} case${skipped === 1 ? "" : "s"} without a golden run were left out` : ""}`
  );
  return EXIT_OK;
}

// --- import ------------------------------------------------------------------

export async function runGoldenImport(args: ParsedArgs, io: CliIo): Promise<number> {
  const [, , file, extra] = args.positionals;
  if (!file || extra) throw new UsageError("l2m golden import needs exactly one golden-set file");
  const workflowId = oneFlag(args, "workflow");
  if (!workflowId) throw new UsageError("l2m golden import needs --workflow <id>, the workflow the cases are imported into");
  const raw = readFileJson(file);
  const parsed = goldenSetFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`${file} is not a valid l2m.golden-set file (${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message ?? "invalid"})`);
  }
  const publicKey = publicKeyFlag(args);
  if (publicKey) {
    const verified = verifyGoldenSetFile(raw, { publicKey });
    if (!verified.ok) {
      write(io.stderr, `l2m: ${file} was not imported: ${formatVerify(verified, file)}`);
      return EXIT_FAILED;
    }
  }
  const project = oneFlag(args, "project");
  const name = oneFlag(args, "name");
  const target = apiTarget(args, io);
  let reply;
  try {
    reply = await apiCall(target, "POST", "/api/eval/datasets/import", { file: raw, workflowId, ...(project ? { projectId: project } : {}), ...(name ? { name } : {}) });
  } catch (error) {
    if (error instanceof RequestError) {
      write(io.stderr, `l2m: import failed: ${cleanServerText(error.message)}`);
      return EXIT_FAILED;
    }
    throw error;
  }
  if (!reply.ok) {
    write(io.stderr, `l2m: import failed with ${reply.status}: ${cleanServerText(replyError(reply))}`);
    // The API rejecting the file or the flags is a usage error; anything else is a failed request.
    return reply.status === 400 ? EXIT_USAGE : EXIT_FAILED;
  }
  const body = isObject(reply.body) ? reply.body : {};
  const dataset = isObject(body.dataset) ? body.dataset : {};
  if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else {
    write(io.stdout, `Imported ${Number(body.imported ?? 0)} case${Number(body.imported ?? 0) === 1 ? "" : "s"} as golden set ${cleanServerText(dataset.id)} (${cleanServerText(dataset.name)}).`);
    for (const warning of Array.isArray(body.warnings) ? body.warnings : []) write(io.stdout, `  warning: ${cleanServerText(warning)}`);
  }
  return EXIT_OK;
}
