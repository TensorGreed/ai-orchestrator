import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveCaptureSurrogateKey } from "../services/replay-capture-service.js";
import { ContentDroppedError, OtelContentMasker, deriveOtelContentSurrogateKey, environmentUrlSecrets, secretValueForms, type OtelContentMaskerOptions } from "./content-masker.js";

const EMAIL = "sam.lee@example.net";
const STORED = "stored-value-Ab12-Cd34";

function masker(overrides: Partial<OtelContentMaskerOptions> = {}) {
  let stored = [STORED];
  let reads = 0;
  let clock = 1_000;
  const instance = new OtelContentMasker({
    key: deriveOtelContentSurrogateKey(Buffer.alloc(32, 7)),
    storedSecretValues: async () => {
      reads += 1;
      return stored;
    },
    otherSecretValues: () => [],
    dictionaries: async () => [],
    now: () => clock,
    ...overrides
  });
  return {
    instance,
    setStored: (values: string[]) => (stored = values),
    reads: () => reads,
    tick: (ms: number) => (clock += ms),
    mask: (value: unknown) => instance.mask([{ id: "input_messages", value }], { deadline: Number.MAX_SAFE_INTEGER })
  };
}

describe("OtelContentMasker", () => {
  it("removes stored secret values and token shapes, and masks personal data with stable surrogates", async () => {
    const m = masker();
    const first = await m.mask({ text: `mail ${EMAIL} key ${STORED} token sk-abcdefghijklmnopqrstu`, apiKey: "anything" });
    const value = first.parts[0]!.value as { text: string; apiKey: string };
    expect(value.text).not.toContain(EMAIL);
    expect(value.text).not.toContain(STORED);
    expect(value.text).not.toContain("sk-abcdefghijklmnopqrstu");
    expect(value.apiKey).toBe("[REDACTED]");
    const surrogate = /mail (\S+) key/.exec(value.text)![1]!;
    const again = (await m.mask(`to ${EMAIL}`)).parts[0]!.value as string;
    expect(again).toBe(`to ${surrogate}`);
  });

  it("uses its own surrogate key, not production capture's", () => {
    const master = crypto.randomBytes(32);
    expect(Buffer.from(deriveOtelContentSurrogateKey(master)).equals(Buffer.from(deriveCaptureSurrogateKey(master)))).toBe(false);
    expect(() => deriveOtelContentSurrogateKey(new Uint8Array(0))).toThrow();
  });

  it("scrubs a value the secret service reports at once, even while the stored values are cached", async () => {
    const m = masker();
    await m.mask("warm the cache");
    m.instance.addSecretValues(["fresh-secret-Zz99-Yy88"]);
    const value = (await m.mask("use fresh-secret-Zz99-Yy88 now")).parts[0]!.value as string;
    expect(value).toBe("use [REDACTED] now");
    expect(m.reads()).toBe(1);
  });

  it("reads stored values again after the cache time", async () => {
    const m = masker({ cacheMs: 1_000 });
    await m.mask("one");
    m.setStored([STORED, "rotated-value-Qq11-Ww22"]);
    expect((await m.mask("rotated-value-Qq11-Ww22")).parts[0]!.value).toBe("rotated-value-Qq11-Ww22");
    m.tick(1_001);
    expect((await m.mask("rotated-value-Qq11-Ww22")).parts[0]!.value).toBe("[REDACTED]");
    expect(m.reads()).toBe(2);
  });

  it("checks final text for secret values and token shapes", async () => {
    const result = await masker().mask("x");
    expect(result.containsSecret(`a ${STORED} b`)).toBe(true);
    expect(result.containsSecret(JSON.stringify({ t: "Bearer abcdefghijklmnop" }))).toBe(true);
    expect(result.containsSecret('{"t":"clean"}')).toBe(false);
  });

  it("fails (so the content is dropped) when dictionaries or secrets cannot be read, past the deadline, and never passes deep content through", async () => {
    await expect(masker({ dictionaries: async () => Promise.reject(new Error("db down")) }).mask("x")).rejects.toThrow("db down");
    await expect(masker({ storedSecretValues: async () => Promise.reject(new Error("vault down")) }).mask("x")).rejects.toThrow("vault down");
    const late = masker();
    await expect(late.instance.mask([{ id: "input_messages", value: Array.from({ length: 5000 }, (_, i) => `row ${i} ${EMAIL}`) }], { deadline: 0 })).rejects.toBeInstanceOf(
      ContentDroppedError
    );
    let deep: unknown = EMAIL;
    for (let i = 0; i < 100; i += 1) deep = [deep];
    // Past the scrubber's depth the content is replaced outright, so nothing deep is exported as it was.
    const deepResult = await masker().mask(deep);
    expect(JSON.stringify(deepResult.parts)).not.toContain(EMAIL);
  });

  it("removes a secret value URL-encoded and base64-encoded too", async () => {
    const odd = "key/with+chars=Zq9";
    const m = masker({ otherSecretValues: () => [odd] });
    const text = `q=${encodeURIComponent(odd)} b=${Buffer.from(odd).toString("base64")} u=${Buffer.from(odd).toString("base64url")} basic=${Buffer.from(STORED).toString("base64")}`;
    const value = (await m.mask(text)).parts[0]!.value as string;
    expect(value).toBe("q=[REDACTED] b=[REDACTED] u=[REDACTED] basic=[REDACTED]");
    expect(secretValueForms(["short"])).toEqual(["short"]);
  });

  it("fails every waiting call when reading secrets hangs, and reads again afterwards", async () => {
    let hang = true;
    const m = masker({
      loadTimeoutMs: 20,
      storedSecretValues: async () => (hang ? await new Promise<string[]>(() => undefined) : [STORED])
    });
    await expect(Promise.all([m.mask("a"), m.mask("b")])).rejects.toBeInstanceOf(ContentDroppedError);
    hang = false;
    expect((await m.mask(STORED)).parts[0]!.value).toBe("[REDACTED]");
  });
});

describe("environmentUrlSecrets", () => {
  it("returns the passwords of URL-valued variables, and the URLs", () => {
    const values = environmentUrlSecrets({
      DATABASE_URL: "postgres://app:pa%24%24-word-77@db.internal:5432/l2m",
      REDIS_URL: "redis://:redis-pass-123@cache:6379",
      PUBLIC_URL: "https://l2m.example.com/",
      OTHER: "user@example.com"
    });
    expect(values).toContain("pa$$-word-77");
    expect(values).toContain("pa%24%24-word-77");
    expect(values).toContain("redis-pass-123");
    expect(values).toContain("postgres://app:pa%24%24-word-77@db.internal:5432/l2m");
    expect(values.some((value) => value.includes("l2m.example.com"))).toBe(false);
  });
});
