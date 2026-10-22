/**
 * Phase 11.1 — `l2m audit verify` against a bundle exported from a locally
 * booted API (testdata/audit-bundle.zip, with the deployment's public key),
 * and against tampered copies of it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { auditBundleSignedBytes, readZip, writeZip } from "@ai-orchestrator/shared";
import { keyIdForPublicKey, parsePublicKeyInput, verifyAuditBundle, type AuditVerifyResult } from "./audit-verify";
import { EXIT_FAILED, EXIT_OK, EXIT_SIGNER_UNVERIFIED, EXIT_USAGE, main, type CliIo } from "./main";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(here, "../testdata/audit-bundle.zip");
const pemPath = path.resolve(here, "../testdata/audit-bundle.pub.pem");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-audit-"));
const original = fs.readFileSync(bundlePath);
const publicKey = parsePublicKeyInput(pemPath);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function io(): CliIo & { out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return { stdin: new PassThrough(), stdout, stderr, env: {}, out: () => out, err: () => err };
}

function entries(): Array<{ path: string; data: Uint8Array }> {
  return readZip(new Uint8Array(original), { inflateRaw: (data) => new Uint8Array(inflateRawSync(data)) });
}

function rezip(list: Array<{ path: string; data: Uint8Array }>): string {
  const file = path.join(tempDir, `${crypto.randomUUID()}.zip`);
  fs.writeFileSync(file, writeZip(list, { deflateRaw: (data) => new Uint8Array(deflateRawSync(data)) }));
  return file;
}

function edit(target: string, change: (text: string) => string): string {
  return rezip(entries().map((entry) => (entry.path === target ? { path: entry.path, data: new TextEncoder().encode(change(new TextDecoder().decode(entry.data))) } : entry)));
}

async function verify(file: string, ...extra: string[]): Promise<{ code: number; result: AuditVerifyResult }> {
  const run = io();
  const code = await main(["audit", "verify", file, "--public-key", pemPath, "--json", ...extra], run);
  return { code, result: JSON.parse(run.out()) as AuditVerifyResult };
}

const failed = (result: AuditVerifyResult) => result.checks.find((entry) => !entry.ok);

describe("l2m audit verify", () => {
  it("passes a bundle exported from the API, with the deployment's public key", async () => {
    const human = io();
    expect(await main(["audit", "verify", bundlePath, "--public-key", pemPath], human)).toBe(EXIT_OK);
    expect(human.out()).toMatch(/^PASS /);
    expect(human.out()).toContain("public key given");
    const { code, result } = await verify(bundlePath);
    expect(code).toBe(EXIT_OK);
    expect(result).toMatchObject({ ok: true, status: "pass", integrityOk: true, signerVerified: true, keySource: "provided", warnings: [] });
    expect(result.checks.map((entry) => entry.name)).toEqual(["archive", "signature file", "signature", "files", "manifest digest", "manifest", "workflow"]);
    expect(result.files).toBe(14);
  });

  it("accepts the key as base64 (raw or SPKI)", () => {
    const raw = publicKey.toString("base64");
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]).toString("base64");
    expect(parsePublicKeyInput(raw).equals(publicKey)).toBe(true);
    expect(parsePublicKeyInput(spki).equals(publicKey)).toBe(true);
  });

  it("never passes on the bundle's own key alone: signer not verified, exit 3", async () => {
    const run = io();
    expect(await main(["audit", "verify", bundlePath, "--json"], run)).toBe(EXIT_SIGNER_UNVERIFIED);
    const result = JSON.parse(run.out()) as AuditVerifyResult;
    expect(result).toMatchObject({ ok: false, status: "signer_unverified", integrityOk: true, signerVerified: false, keySource: "bundle" });
    expect(result.warnings[0]).toContain("SIGNER NOT VERIFIED");
    expect(result.warnings[0]).toContain("internally consistent");
    const human = io();
    expect(await main(["audit", "verify", bundlePath], human)).toBe(EXIT_SIGNER_UNVERIFIED);
    expect(human.out()).toMatch(/^SIGNER NOT VERIFIED /);
    expect(human.out()).not.toMatch(/^PASS/m);

    // Only an explicit --trust-embedded-key turns it into exit 0, with the warning kept.
    const trusted = io();
    expect(await main(["audit", "verify", bundlePath, "--trust-embedded-key"], trusted)).toBe(EXIT_OK);
    expect(trusted.out()).toMatch(/^PASS \(embedded key trusted: SIGNER NOT VERIFIED\)/);
    expect(trusted.out()).toContain("WARNING  SIGNER NOT VERIFIED");
    const trustedJson = io();
    expect(await main(["audit", "verify", bundlePath, "--trust-embedded-key", "--json"], trustedJson)).toBe(EXIT_OK);
    expect(JSON.parse(trustedJson.out())).toMatchObject({ ok: true, signerVerified: false, embeddedKeyTrusted: true });
    expect(await main(["audit", "verify", bundlePath, "--trust-embedded-key", "--public-key", pemPath], io())).toBe(EXIT_USAGE);
  });

  it("does not pass a forged bundle re-signed with an attacker key embedded in it", async () => {
    const list = entries();
    const manifest = list.find((entry) => entry.path === "manifest.json")!;
    const changed = new TextEncoder().encode(new TextDecoder().decode(manifest.data).replace('"status":"success"', '"status":"failed"'));
    const digest = crypto.createHash("sha256").update(changed).digest("hex");
    const signature = JSON.parse(new TextDecoder().decode(list.find((entry) => entry.path === "signature.json")!.data)) as Record<string, unknown> & {
      index: { manifestDigest: string; files: Array<{ path: string; sha256: string; bytes: number }> };
    };
    signature.index.manifestDigest = digest;
    const indexed = signature.index.files.find((entry) => entry.path === "manifest.json")!;
    indexed.sha256 = digest;
    indexed.bytes = changed.length;
    const attacker = crypto.generateKeyPairSync("ed25519");
    const raw = Buffer.from((attacker.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
    signature.publicKey = raw.toString("base64");
    signature.keyId = keyIdForPublicKey(raw);
    const { signature: _old, ...body } = signature;
    signature.signature = crypto.sign(null, Buffer.from(auditBundleSignedBytes(body as never)), attacker.privateKey).toString("base64");
    const file = rezip(
      list.map((entry) =>
        entry.path === "manifest.json" ? { path: entry.path, data: changed } : entry.path === "signature.json" ? { path: entry.path, data: new TextEncoder().encode(JSON.stringify(signature)) } : entry
      )
    );
    const run = io();
    expect(await main(["audit", "verify", file, "--json"], run)).toBe(EXIT_SIGNER_UNVERIFIED);
    expect(JSON.parse(run.out())).toMatchObject({ ok: false, integrityOk: true, signerVerified: false });
    const { code } = await verify(file);
    expect(code).toBe(EXIT_FAILED);
  });

  it("caps the expanded size: 512 MiB by default, --max-bytes to change it", async () => {
    const small = io();
    expect(await main(["audit", "verify", bundlePath, "--public-key", pemPath, "--max-bytes", "1000", "--json"], small)).toBe(EXIT_USAGE);
    const { code, result } = await verify(bundlePath, "--max-bytes", "200000");
    expect(code).toBe(EXIT_OK);
    expect(result.ok).toBe(true);
    const tight = verifyAuditBundle(new Uint8Array(original), { publicKey, maxBytes: original.length + 10 });
    expect(tight.checks[0]).toMatchObject({ name: "archive", ok: false });
    expect(tight.checks[0]!.detail).toMatch(/expands past/);
    expect(await main(["audit", "verify", bundlePath, "--max-bytes", "lots"], io())).toBe(EXIT_USAGE);
  });

  it("fails a modified manifest", async () => {
    const file = edit("manifest.json", (text) => text.replace('"status":"success"', '"status":"failed"'));
    const { code, result } = await verify(file);
    expect(code).toBe(EXIT_FAILED);
    expect(failed(result)).toMatchObject({ name: "files", detail: "modified: manifest.json" });
  });

  it("fails a modified manifest even when the index is rewritten to match (signature breaks)", async () => {
    const list = entries();
    const manifest = list.find((entry) => entry.path === "manifest.json")!;
    const changed = new TextEncoder().encode(new TextDecoder().decode(manifest.data).replace('"status":"success"', '"status":"failed"'));
    const digest = crypto.createHash("sha256").update(changed).digest("hex");
    const signature = JSON.parse(new TextDecoder().decode(list.find((entry) => entry.path === "signature.json")!.data)) as {
      index: { manifestDigest: string; files: Array<{ path: string; sha256: string; bytes: number }> };
    };
    signature.index.manifestDigest = digest;
    const indexed = signature.index.files.find((entry) => entry.path === "manifest.json")!;
    indexed.sha256 = digest;
    indexed.bytes = changed.length;
    const file = rezip(
      list.map((entry) =>
        entry.path === "manifest.json" ? { path: entry.path, data: changed } : entry.path === "signature.json" ? { path: entry.path, data: new TextEncoder().encode(JSON.stringify(signature)) } : entry
      )
    );
    const { code, result } = await verify(file);
    expect(code).toBe(EXIT_FAILED);
    expect(failed(result)?.name).toBe("signature");
  });

  it("fails a modified node I/O file", async () => {
    const node = entries().find((entry) => /^execution\/nodes\/\d{3}-agent\.json$/.test(entry.path))!.path;
    const { code, result } = await verify(edit(node, (text) => text.replace("recovery", "rec0very")));
    expect(code).toBe(EXIT_FAILED);
    expect(failed(result)).toMatchObject({ name: "files", detail: `modified: ${node}` });
  });

  it("fails an extra file and a missing file", async () => {
    const extra = await verify(rezip([...entries(), { path: "execution/notes.txt", data: new TextEncoder().encode("added later") }]));
    expect(extra.code).toBe(EXIT_FAILED);
    expect(failed(extra.result)).toMatchObject({ name: "files", detail: "not in the signed index: execution/notes.txt" });

    const missing = await verify(rezip(entries().filter((entry) => entry.path !== "execution/trace.json")));
    expect(missing.code).toBe(EXIT_FAILED);
    expect(failed(missing.result)).toMatchObject({ name: "files", detail: "missing: execution/trace.json" });

    const noSignature = await verify(rezip(entries().filter((entry) => entry.path !== "signature.json")));
    expect(noSignature.code).toBe(EXIT_FAILED);
    expect(failed(noSignature.result)?.name).toBe("signature file");
  });

  it("fails with the wrong public key", async () => {
    const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
    const otherFile = path.join(tempDir, "other.pem");
    fs.writeFileSync(otherFile, other);
    const run = io();
    expect(await main(["audit", "verify", bundlePath, "--public-key", otherFile, "--json"], run)).toBe(EXIT_FAILED);
    const result = JSON.parse(run.out()) as AuditVerifyResult;
    expect(failed(result)?.name).toBe("signature");
    expect(failed(result)?.detail).toContain("but the public key given is");

    // A bundle re-signed by someone else's key, with that key embedded, still fails against the deployment key.
    const forged = verifyAuditBundle(new Uint8Array(original), { publicKey: Buffer.alloc(32, 7) });
    expect(forged.ok).toBe(false);
  });

  it("fails a truncated or corrupted zip", async () => {
    const truncated = path.join(tempDir, "truncated.zip");
    fs.writeFileSync(truncated, original.subarray(0, Math.floor(original.length / 2)));
    const cut = await verify(truncated);
    expect(cut.code).toBe(EXIT_FAILED);
    expect(failed(cut.result)?.name).toBe("archive");

    const flipped = Buffer.from(original);
    flipped[200] = flipped[200]! ^ 0xff;
    const corrupt = path.join(tempDir, "corrupt.zip");
    fs.writeFileSync(corrupt, flipped);
    const bad = await verify(corrupt);
    expect(bad.code).toBe(EXIT_FAILED);
    expect(bad.result.ok).toBe(false);
  });

  it("exits 2 on usage errors", async () => {
    expect(await main(["audit", "verify"], io())).toBe(EXIT_USAGE);
    expect(await main(["audit", "verify", path.join(tempDir, "missing.zip")], io())).toBe(EXIT_USAGE);
    expect(await main(["audit", "verify", bundlePath, "--public-key", "not-a-key-or-file"], io())).toBe(EXIT_USAGE);
    expect(await main(["audit", "verify", bundlePath, "--public-key", "c2hvcnQ="], io())).toBe(EXIT_USAGE);
  });
});
