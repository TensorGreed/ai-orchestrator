import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadNerConfig } from "./config.js";

describe("loadNerConfig", () => {
  it("has safe defaults: loopback, no token, one worker, bounded inputs", () => {
    const config = loadNerConfig({});
    expect(config).toMatchObject({ host: "127.0.0.1", port: 8000, token: undefined, workers: 1, threads: 2, maxQueue: 16, maxTextChars: 20_000, maxRequestChars: 200_000, maxBodyBytes: 2 * 1024 * 1024 });
    expect(path.isAbsolute(config.modelsDir)).toBe(true);
  });

  it("treats blank values as unset (compose interpolation leaves them blank)", () => {
    expect(loadNerConfig({ NER_TOKEN: "", NER_WORKERS: " " }).token).toBeUndefined();
  });

  it("reads a token from the environment or a file, never both, and refuses a short one", () => {
    expect(loadNerConfig({ NER_TOKEN: "a-long-enough-token-1234" }).token).toBe("a-long-enough-token-1234");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "l2m-ner-config-")), "token");
    writeFileSync(file, "file-token-0123456789\n");
    expect(loadNerConfig({ NER_TOKEN_FILE: file }).token).toBe("file-token-0123456789");
    expect(() => loadNerConfig({ NER_TOKEN: "a-long-enough-token-1234", NER_TOKEN_FILE: file })).toThrow(/not both/);
    expect(() => loadNerConfig({ NER_TOKEN: "short" })).toThrow(/at least 16/);
    expect(() => loadNerConfig({ NER_TOKEN: "has a space in the token" })).toThrow(/printable ASCII/);
  });

  it("never prints a value in its errors", () => {
    try {
      loadNerConfig({ NER_PORT: "secret-value-here" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("NER_PORT");
      expect((error as Error).message).not.toContain("secret-value-here");
    }
  });

  it("refuses out-of-range numbers and a per-text limit above the request limit", () => {
    expect(() => loadNerConfig({ NER_WORKERS: "17" })).toThrow(/NER_WORKERS/);
    expect(() => loadNerConfig({ NER_PORT: "0" })).toThrow(/NER_PORT/);
    expect(() => loadNerConfig({ NER_MAX_TEXT_CHARS: "500", NER_MAX_REQUEST_CHARS: "100" })).toThrow(/NER_MAX_TEXT_CHARS/);
    expect(loadNerConfig({ NER_WORKERS: "0" }).workers).toBe(0);
  });
});
