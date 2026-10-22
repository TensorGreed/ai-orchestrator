/**
 * Phase 11.1 — the secret scrubber used for manifests and audit bundles.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@ai-orchestrator/shared";
import { environmentSecretValues, isTextMime, REDACTED, SecretScrubber } from "./audit-scrub.js";

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
