import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  AUDIT_BUNDLE_SIGNATURE_FORMAT,
  auditBundleSignatureSchema,
  auditBundleSignedBytes,
  canonicalJson,
  canonicalJsonBytes,
  RUN_MANIFEST_FORMAT,
  runManifestAttestationBytes,
  runManifestSchema,
  type AuditBundleSignature,
  type RunManifest
} from "./audit-manifest";
import { crc32, isSafeZipPath, prepareZip, readZip, writeZip, ZipFormatError } from "./zip-archive";

const HASH = "a".repeat(64);

function minimalManifest(): RunManifest {
  return {
    format: RUN_MANIFEST_FORMAT,
    manifestVersion: 1,
    generatedAt: "2026-10-22T10:00:00.000Z",
    deployment: { keyId: "0123456789abcdef", algorithm: "Ed25519" },
    run: {
      executionId: "exec-1",
      status: "success",
      triggerType: "manual",
      subject: "ana@example.com",
      startedAt: "2026-10-22T09:59:00.000Z",
      completedAt: "2026-10-22T10:00:00.000Z",
      durationMs: 60000,
      error: null,
      inputDigest: HASH,
      outputDigest: null
    },
    workflow: {
      id: "wf-1",
      name: "Support triage",
      schemaVersion: "1.0.0",
      workflowVersion: 3,
      savedVersion: 3,
      hash: HASH,
      source: "captured",
      nodeCount: 1,
      edgeCount: 0
    },
    nodes: [
      {
        id: "n1",
        type: "llm_call",
        name: "Model",
        status: "success",
        startedAt: null,
        completedAt: null,
        durationMs: 5,
        attempts: null,
        errorCategory: null,
        config: { provider: { providerId: "openai", secretRef: { secretId: "sec_1" } } },
        inputDigest: HASH,
        outputDigest: HASH
      }
    ],
    modelCalls: [],
    toolCalls: [],
    mcpServers: [],
    prompts: [],
    citations: [],
    approvals: [],
    totals: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, costUsd: null, modelCalls: 0, toolCalls: 0 }
  };
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and ignores insertion order", () => {
    const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [3, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("sorts by UTF-16 code units, not locale", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, "é": 4, "Z": 5 })).toBe('{"B":2,"Z":5,"a":3,"b":1,"é":4}');
  });

  it("drops undefined members and keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null, c: [undefined, 1] })).toBe('{"b":null,"c":[null,1]}');
  });

  it("writes numbers in their shortest round-trip form", () => {
    expect(canonicalJson({ a: 1.0, b: 0.1 + 0.2, c: 1e21, d: -0, e: 1e-7, f: 123456789012345680000 })).toBe(
      '{"a":1,"b":0.30000000000000004,"c":1e+21,"d":0,"e":1e-7,"f":123456789012345680000}'
    );
    expect(canonicalJson(JSON.parse("[1.50, 2.0e0, 100E-2]"))).toBe("[1.5,2,1]");
  });

  it("refuses values that have no JSON form", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: BigInt(1) })).toThrow(/bigint/);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);
  });

  it("keeps unicode stable: UTF-8 output, escaped lone surrogates, no normalisation", () => {
    const value = { emoji: "🚀", cjk: "日本", combining: "e\u0301", precomposed: "\u00e9", lone: "\ud800", control: "\u0007" };
    const text = canonicalJson(value);
    expect(text).toBe('{"cjk":"\u65e5\u672c","combining":"e\u0301","control":"\\u0007","emoji":"\ud83d\ude80","lone":"\\ud800","precomposed":"\u00e9"}');
    const bytes = canonicalJsonBytes(value);
    expect(new TextDecoder().decode(bytes)).toBe(text);
    // "🚀" is four UTF-8 bytes; the decomposed and precomposed "é" stay different.
    expect(Array.from(canonicalJsonBytes("🚀"))).toEqual([0x22, 0xf0, 0x9f, 0x9a, 0x80, 0x22]);
    expect(canonicalJson("e\u0301")).not.toBe(canonicalJson("\u00e9"));
  });

  it("is byte-identical across re-parsing", () => {
    const manifest = minimalManifest();
    const once = canonicalJson(manifest);
    const twice = canonicalJson(JSON.parse(once));
    expect(twice).toBe(once);
  });

  it("serialises dates through toJSON", () => {
    expect(canonicalJson({ at: new Date("2026-10-22T00:00:00.000Z") })).toBe('{"at":"2026-10-22T00:00:00.000Z"}');
  });
});

describe("run manifest schema", () => {
  it("accepts a minimal manifest and typed guard extensions", () => {
    const manifest = minimalManifest();
    expect(runManifestSchema.safeParse(manifest).success).toBe(true);
    const withGuard = {
      ...manifest,
      extensions: {
        guard: {
          verdicts: [
            {
              verdictId: "v1",
              nodeId: "agent",
              channel: "prompt",
              placement: "agent",
              iteration: 1,
              toolName: null,
              detectorId: "dlp.patterns",
              category: "pii",
              requestedAction: "redact",
              effectiveAction: "redact",
              verdictAction: "redact",
              shadow: false,
              profileId: "default",
              profileVersion: 1,
              profileHash: HASH
            }
          ],
          summary: { verdicts: 1, findings: 1, blocked: 0, byAction: { redact: 1 } }
        },
        "approval_gates.v1": { decisions: [] }
      }
    };
    const parsed = runManifestSchema.parse(withGuard);
    expect(parsed.extensions?.["approval_gates.v1"]).toEqual({ decisions: [] });
  });

  it("rejects malformed guard extensions, unknown versions and bad digests", () => {
    const manifest = minimalManifest();
    expect(runManifestSchema.safeParse({ ...manifest, manifestVersion: 2 }).success).toBe(false);
    expect(runManifestSchema.safeParse({ ...manifest, extensions: { guard: { verdicts: "all" } } }).success).toBe(false);
    expect(runManifestSchema.safeParse({ ...manifest, run: { ...manifest.run, inputDigest: "ABC" } }).success).toBe(false);
    expect(
      runManifestSchema.safeParse({ ...manifest, toolCalls: [{ ...{ nodeId: "a", iteration: null, toolCallId: null, toolName: "t", adapterId: null, registryServerId: null, serverIdentity: null, schemaSnapshotHash: null, argsDigest: null, resultDigest: null, startedAt: null, durationMs: null }, outcome: "maybe" }] }).success
    ).toBe(false);
  });
});

describe("signed bytes", () => {
  it("cover every signature.json field except the signature", () => {
    const base: Omit<AuditBundleSignature, "signature"> = {
      format: AUDIT_BUNDLE_SIGNATURE_FORMAT,
      version: 1 as const,
      algorithm: "Ed25519" as const,
      keyId: "0123456789abcdef",
      publicKey: "cHVibGlj",
      signedAt: "2026-10-22T10:00:00.000Z",
      index: { executionId: "e", workflowId: "w", manifestDigest: HASH, files: [{ path: "manifest.json", sha256: HASH, bytes: 10 }] }
    };
    const bytes = new TextDecoder().decode(auditBundleSignedBytes(base));
    expect(bytes).toBe(canonicalJson(base));
    expect(auditBundleSignatureSchema.safeParse({ ...base, signature: "c2ln" }).success).toBe(true);
    const changed = new TextDecoder().decode(auditBundleSignedBytes({ ...base, index: { ...base.index, files: [{ path: "manifest.json", sha256: HASH, bytes: 11 }] } }));
    expect(changed).not.toBe(bytes);
    const attestation = new TextDecoder().decode(runManifestAttestationBytes({ executionId: "e", manifestDigest: HASH, keyId: "k", signedAt: "t" }));
    expect(attestation).toBe(`{"executionId":"e","format":"l2m.run-manifest-attestation","keyId":"k","manifestDigest":"${HASH}","signedAt":"t"}`);
  });
});

describe("zip archive", () => {
  const inflate = (data: Uint8Array, expected: number) => new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, expected) }));
  const deflate = (data: Uint8Array) => new Uint8Array(deflateRawSync(data));
  const text = (value: string) => new TextEncoder().encode(value);
  const files = [
    { path: "manifest.json", data: text("{\"a\":1}") },
    { path: "execution/nodes/001-agent.json", data: text("x".repeat(5000)) },
    { path: "outputs/chart/ünïcode.svg", data: text("<svg/>") },
    { path: "empty.txt", data: new Uint8Array() }
  ];

  it("round-trips stored and deflated entries and computes the size up front", () => {
    const prepared = prepareZip(files, { deflateRaw: deflate });
    const bytes = writeZip(files, { deflateRaw: deflate });
    expect(bytes.length).toBe(prepared.size);
    const read = readZip(bytes, { inflateRaw: inflate });
    expect(read.map((entry) => entry.path)).toEqual(files.map((entry) => entry.path));
    read.forEach((entry, index) => expect(Array.from(entry.data)).toEqual(Array.from(files[index]!.data)));
    expect(bytes.length).toBeLessThan(5000);
  });

  it("writes identical bytes for identical input", () => {
    const stamp = new Date("2026-10-22T10:00:00.000Z");
    expect(Buffer.from(writeZip(files, { deflateRaw: deflate, modifiedAt: stamp })).equals(Buffer.from(writeZip(files, { deflateRaw: deflate, modifiedAt: stamp })))).toBe(true);
  });

  it("matches the standard CRC-32", () => {
    expect(crc32(text("123456789")).toString(16)).toBe("cbf43926");
  });

  it("refuses unsafe and duplicate paths when writing", () => {
    expect(() => writeZip([{ path: "../x", data: text("a") }])).toThrow(ZipFormatError);
    expect(() => writeZip([{ path: "a", data: text("a") }, { path: "a", data: text("b") }])).toThrow(/Duplicate/);
    for (const bad of ["/abs", "a/../b", "a\\b", "C:/x", "a//b", "./a", ""]) expect(isSafeZipPath(bad)).toBe(false);
    expect(isSafeZipPath("execution/nodes/001-a.json")).toBe(true);
  });

  it("rejects truncated, padded and corrupted archives", () => {
    const bytes = writeZip(files, { deflateRaw: deflate });
    expect(() => readZip(bytes.subarray(0, bytes.length - 5), { inflateRaw: inflate })).toThrow(ZipFormatError);
    expect(() => readZip(bytes.subarray(0, Math.floor(bytes.length / 2)), { inflateRaw: inflate })).toThrow(ZipFormatError);
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes);
    expect(() => readZip(padded, { inflateRaw: inflate })).toThrow(ZipFormatError);
    const flipped = new Uint8Array(bytes);
    // Corrupt one byte of the first (stored) entry's payload.
    flipped[30 + "manifest.json".length + 2] ^= 0xff;
    expect(() => readZip(flipped, { inflateRaw: inflate })).toThrow(/CRC/);
    expect(() => readZip(new Uint8Array(10), { inflateRaw: inflate })).toThrow(/too short/);
  });

  it("enforces the expansion limit", () => {
    const bytes = writeZip([{ path: "big.txt", data: text("y".repeat(10_000)) }], { deflateRaw: deflate });
    expect(() => readZip(bytes, { inflateRaw: inflate, maxTotalBytes: 1000 })).toThrow(/expands past/);
  });
});
