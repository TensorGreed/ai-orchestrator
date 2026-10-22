/**
 * Phase 11.1 — the secret scrubber used for manifests and audit bundles.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson, runManifestConstantGuide, schemaConstantGuide } from "@ai-orchestrator/shared";
import { environmentSecretValues, isTextMime, REDACTED, scrubExemptionWarnings, SecretScrubber } from "./audit-scrub.js";

const QUOTE = 'pa"ss\\word-12"34';
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const UNICODE = "clé-sécrète-日本-🚀";
const CONTROL = "tab\there\u0007-99";

describe("SecretScrubber", () => {
  const scrubber = new SecretScrubber([QUOTE, PEM, UNICODE, CONTROL, "short", ""]);

  it("scrubs a value tree before serialisation, keys included, so escaped forms never reach the text", () => {
    const value = { a: `x ${QUOTE} y`, list: [PEM, { [`k-${UNICODE}`]: CONTROL }] };
    const text = JSON.stringify(scrubber.tree(value));
    for (const secret of [QUOTE, PEM, UNICODE, CONTROL]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
    expect(JSON.parse(text)).toEqual({ a: `x ${REDACTED} y`, list: [REDACTED, { [`k-${REDACTED}`]: REDACTED }] });
  });

  it("also replaces the JSON-escaped form in serialised text", () => {
    const text = JSON.stringify({ a: QUOTE, b: PEM, c: CONTROL, d: UNICODE });
    expect(text).not.toContain(QUOTE);
    const scrubbed = scrubber.text(text);
    expect(JSON.parse(scrubbed)).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED, d: REDACTED });
  });

  it("ignores values shorter than 6 characters", () => {
    expect(scrubber.size).toBe(4);
    expect(scrubber.text("a short note")).toBe("a short note");
  });

  it("scrubs text data URLs inside a value and replaces binary ones that carry a secret", () => {
    const text = `data:text/csv;charset=utf-8;base64,${Buffer.from(`a,${UNICODE}\n`).toString("base64")}`;
    const out = scrubber.tree({ text, png: `data:image/png;base64,${Buffer.from(`\x89PNG${QUOTE}`, "latin1").toString("base64")}` }) as Record<string, string>;
    expect(out.text.startsWith("data:text/csv;charset=utf-8;base64,")).toBe(true);
    expect(Buffer.from(out.text.split(",")[1]!, "base64").toString("utf8")).toBe(`a,${REDACTED}\n`);
    expect(out.png).toBe(REDACTED);
  });

  it("finds secrets in binary bytes as UTF-8, UTF-16 (both byte orders) and JSON-escaped text", () => {
    const be = Buffer.from(UNICODE, "utf16le");
    for (let index = 0; index + 1 < be.length; index += 2) [be[index], be[index + 1]] = [be[index + 1]!, be[index]!];
    for (const bytes of [Buffer.from(UNICODE), Buffer.from(UNICODE, "utf16le"), be, Buffer.from(JSON.stringify(PEM))]) {
      expect(scrubber.containsSecret(new Uint8Array(Buffer.concat([Buffer.from([0, 1, 2]), bytes])))).toBe(true);
      expect(scrubber.bytes(new Uint8Array(bytes), "application/pdf")).toBeNull();
    }
    const clean = new Uint8Array(Buffer.from("nothing here"));
    expect(scrubber.bytes(clean, "image/png")).toBe(clean);
  });

  it("rewrites text files and leaves invalid UTF-8 to the binary check", () => {
    const data = new TextEncoder().encode(`<svg>${QUOTE}</svg>`);
    expect(new TextDecoder().decode(scrubber.bytes(data, "image/svg+xml")!)).toBe(`<svg>${REDACTED}</svg>`);
    const invalid = new Uint8Array([0xff, 0xfe, ...Buffer.from(PEM)]);
    expect(scrubber.bytes(invalid, "text/plain")).toBeNull();
    expect(isTextMime("text/markdown")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("application/vnd.api+json")).toBe(true);
    expect(isTextMime("application/pdf")).toBe(false);
  });

  it("keeps own __proto__ keys, so a scrubbed tree serialises like the original", () => {
    const parsed = JSON.parse('{"__proto__":{"x":1},"a":"b"}') as unknown;
    expect(canonicalJson(scrubber.tree(parsed))).toBe(canonicalJson(parsed));
    expect(canonicalJson(parsed)).toContain("__proto__");
  });

  it("counts replacements", () => {
    scrubber.resetHits();
    scrubber.text(`${QUOTE} ${QUOTE}`);
    expect(scrubber.hits).toBe(2);
  });
});

describe("SecretScrubber guided by a schema's enum and literal positions", () => {
  const guide = schemaConstantGuide(
    z.object({
      status: z.enum(["success", "error"]),
      algorithm: z.literal("Ed25519"),
      label: z.string(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      steps: z.array(z.object({ outcome: z.enum(["policy_blocked", "ok"]), note: z.string().nullable() })),
      config: z.record(z.string(), z.unknown())
    })
  );

  it("keeps a value at an enum or literal position only when it equals one of that position's constants", () => {
    const scrubber = new SecretScrubber(["success", "Ed25519", "blocked"]);
    const out = scrubber.tree(
      { status: "success", algorithm: "Ed25519", label: "success", steps: [{ outcome: "policy_blocked", note: "success" }], config: { status: "success" } },
      { guide }
    );
    expect(out).toEqual({
      status: "success",
      algorithm: "Ed25519",
      label: REDACTED,
      steps: [{ outcome: "policy_blocked", note: REDACTED }],
      config: { status: REDACTED }
    });
  });

  it("scrubs a value at an enum position that is not one of its constants", () => {
    const scrubber = new SecretScrubber(["success", "sk-live-0123456789"]);
    const out = scrubber.tree({ status: "success and more", algorithm: "sk-live-0123456789", steps: [{ outcome: "error success" }] }, { guide }) as Record<string, unknown>;
    expect(out).toEqual({ status: `${REDACTED} and more`, algorithm: REDACTED, steps: [{ outcome: `error ${REDACTED}` }] });
    // A constant of another position is not exempt here.
    expect(scrubber.tree({ label: "success" }, { guide })).toEqual({ label: REDACTED });
  });

  it("still scrubs format-constrained strings and undeclared keys", () => {
    const digest = createHash("sha256").update("workflow").digest("hex");
    const scrubber = new SecretScrubber([digest.slice(4, 20), "status"]);
    const out = scrubber.tree({ digest, status: "error", config: { status: "x" }, extra: { status: "y" } }, { guide }) as Record<string, unknown>;
    expect(out.digest).toBe(`${digest.slice(0, 4)}${REDACTED}${digest.slice(20)}`);
    // Declared keys are schema constants; keys of a free record are not.
    expect(out.status).toBe("error");
    expect(out.config).toEqual({ [REDACTED]: "x" });
    expect(out.extra).toEqual({ [REDACTED]: "y" });
  });

  it("behaves exactly as before without a guide", () => {
    const scrubber = new SecretScrubber(["success"]);
    expect(scrubber.tree({ status: "success", algorithm: "success" })).toEqual({ status: REDACTED, algorithm: REDACTED });
  });

  it("works with the run manifest's own guide", () => {
    const scrubber = new SecretScrubber(["success", "captured", "system"]);
    const out = scrubber.tree(
      {
        run: { status: "success", error: "success" },
        workflow: { source: "captured", name: "captured" },
        nodes: [{ status: "success", name: "success", config: { note: "success" } }],
        prompts: [{ role: "system", rendered: "system" }]
      },
      { guide: runManifestConstantGuide() }
    );
    expect(out).toEqual({
      run: { status: "success", error: REDACTED },
      workflow: { source: "captured", name: REDACTED },
      nodes: [{ status: "success", name: REDACTED, config: { note: REDACTED } }],
      prompts: [{ role: "system", rendered: REDACTED }]
    });
  });
});

describe("scrubExemptionWarnings", () => {
  it("warns when a value matches a run-record constant it would not be hidden in, without echoing it", () => {
    for (const value of ["success", "captured", "workflow", "blocked"]) {
      const warnings = scrubExemptionWarnings(value);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain(value);
    }
  });

  it("does not warn for unique values, other cases, or values too short to be scrubbed", () => {
    expect(scrubExemptionWarnings("sk-live-9f8e7d6c5b4a")).toEqual([]);
    expect(scrubExemptionWarnings("Success")).toEqual([]);
    expect(scrubExemptionWarnings("error")).toEqual([]);
    expect(scrubExemptionWarnings("ok")).toEqual([]);
  });
});

describe("environmentSecretValues", () => {
  it("takes credential variables and skips settings that only mention one in their name", () => {
    const values = environmentSecretValues(
      { OPENAI_API_KEY: "sk-config-value-123", GEMINI_API_KEY: undefined, LDAP_BIND_PASSWORD: "ldap-password-1" },
      {
        ANTHROPIC_API_KEY: "sk-ant-env-value-456",
        GITHUB_TOKEN: "ghp_tokenvalue000",
        EXTERNAL_SECRETS_CACHE_TTL_MS: "300000",
        EVAL_JUDGE_MAX_TOKENS: "100000",
        SESSION_COOKIE_NAME: "orchestrator_session",
        SOME_SECRET_FLAG: "true",
        SHORT_TOKEN: "abc",
        HOME: "/home/someone-long"
      }
    );
    expect(values.sort()).toEqual(["ghp_tokenvalue000", "ldap-password-1", "sk-ant-env-value-456", "sk-config-value-123"]);
  });
});
