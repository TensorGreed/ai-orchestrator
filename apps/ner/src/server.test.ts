import { rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeModel } from "../test/helpers.js";
import { loadNerConfig, type NerConfig } from "./config.js";
import type { GlinerPromptCut, RawSpan } from "./gliner.js";
import { inlineExecutor } from "./pool.js";
import { createNerServer } from "./server.js";
import { NerService } from "./service.js";

/**
 * The service end to end over HTTP, with the model replaced by a stand-in core (no ONNX Runtime, no weights): it
 * "finds" a few fixed strings, so the contract, limits, errors and the model lifecycle are what is tested.
 */

const KNOWN: Record<string, string[]> = { name: ["Anna Lee"], "location street": ["12 Main Street"], "location city": ["Paris", "Springfield"] };

function standInCore(options: { delayMs?: number; fail?: boolean } = {}) {
  return {
    async recognize(text: string, cuts: readonly GlinerPromptCut[], isCancelled: () => boolean = () => false): Promise<RawSpan[]> {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (isCancelled()) throw new Error("cancelled");
      if (options.fail) throw new Error(`boom while reading ${text}`);
      const spans: RawSpan[] = [];
      cuts.forEach((cut, prompt) => {
        for (const value of KNOWN[cut.prompt] ?? []) {
          for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) spans.push({ start: at, end: at + value.length, prompt, score: 0.9 });
        }
      });
      return spans;
    }
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(options: { env?: NodeJS.ProcessEnv; corrupt?: string; missing?: boolean; core?: ReturnType<typeof standInCore>; crash?: { trigger?: () => void } } = {}) {
  const fake = fakeModel(options.corrupt ? { corrupt: options.corrupt } : {});
  if (options.missing) rmSync(path.join(fake.modelsDir, "example__fake-gliner"), { recursive: true, force: true });
  const config: NerConfig = loadNerConfig({ NER_MODEL_DIR: fake.modelsDir, NER_MODEL_RETRY_MS: "1000", ...options.env });
  const logs: string[] = [];
  const service = new NerService({
    config,
    manifest: fake.manifest,
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    executorFactory: () => async () => {
      const executor = inlineExecutor(options.core ?? standInCore());
      if (!options.crash) return executor;
      return {
        ...executor,
        onExit: (listener: (reason: string) => void) => {
          options.crash!.trigger = () => listener("test crash");
        }
      };
    }
  });
  await service.start();
  const server = createNerServer(service, config, { info: (entry) => logs.push(JSON.stringify(entry)) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await service.close();
    rmSync(fake.modelsDir, { recursive: true, force: true });
  };
  servers.push({ close });
  return { url, service, logs, fake, config };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}/v1/entities`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

const SECRET = "Anna Lee";
const request = (texts: string[], extra: Record<string, unknown> = {}) => ({ texts, labels: ["person_name", "location", "street_address"], language: "en", ...extra });

describe("POST /v1/entities", () => {
  it("answers one result per text with UTF-16 offsets, labels, calibrated scores and the model", async () => {
    const { url, fake } = await start();
    const texts = ["🙂 Write to Anna Lee at 12 Main Street, Springfield, IL 62704.", "", "Paris in spring"];
    const { status, body, headers } = await post(url, request(texts));
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body.results).toHaveLength(3);
    const first = body.results[0].entities.map((entity: { start: number; end: number; label: string; score: number }) => [entity.label, texts[0]!.slice(entity.start, entity.end), entity.score]);
    expect(first).toEqual([
      ["person_name", "Anna Lee", 0.96],
      ["street_address", "12 Main Street, Springfield, IL 62704", 0.96]
    ]);
    expect(body.results[1].entities).toEqual([]);
    expect(body.results[2].entities.map((entity: { label: string }) => entity.label)).toEqual(["location"]);
    expect(body.model).toEqual({ id: fake.model.id, version: expect.stringMatching(/^abc123-[0-9a-f]{8}$/), sha256: fake.model.files[0]!.sha256 });
  });

  it("returns only the labels asked for", async () => {
    const { url } = await start();
    const { body } = await post(url, { texts: ["Anna Lee in Paris"], labels: ["location"], language: "en" });
    expect(body.results[0].entities.map((entity: { label: string }) => entity.label)).toEqual(["location"]);
  });

  it("refuses bad requests without quoting the input", async () => {
    const { url, logs } = await start();
    const cases: Array<[unknown, number, string]> = [
      [{ texts: [SECRET], labels: ["person_name"], language: "en", extra: SECRET }, 400, "bad_request"],
      [{ texts: [SECRET], labels: ["phone_number"], language: "en" }, 400, "bad_request"],
      [{ texts: [], labels: ["person_name"], language: "en" }, 400, "bad_request"],
      [{ texts: Array.from({ length: 65 }, () => SECRET), labels: ["person_name"], language: "en" }, 400, "bad_request"],
      [{ texts: [SECRET], labels: ["person_name", "person_name"], language: "en" }, 400, "bad_request"],
      [{ texts: [SECRET], labels: ["person_name"], language: "en", threshold: 2 }, 400, "bad_request"],
      [{ texts: [SECRET], labels: ["person_name"], language: "de" }, 400, "unsupported_language"],
      [`{"texts": ["${SECRET}"`, 400, "bad_request"]
    ];
    for (const [body, status, code] of cases) {
      const response = await post(url, body);
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    }
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("enforces the size limits with 413", async () => {
    const { url } = await start({ env: { NER_MAX_TEXT_CHARS: "100", NER_MAX_REQUEST_CHARS: "150", NER_MAX_BODY_BYTES: "2048" } });
    expect((await post(url, request(["x".repeat(101)]))).body.error).toEqual({ code: "too_large", message: "texts.0 is longer than 100 characters" });
    expect((await post(url, request(["x".repeat(100), "y".repeat(60)]))).status).toBe(413);
    const big = await post(url, request(["z".repeat(3000)]));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("too_large");
  });

  it("needs application/json and POST, and answers 404 for other routes", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/v1/entities`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    const get = await fetch(`${url}/v1/entities`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const other = await fetch(`${url}/v1/${encodeURIComponent(SECRET)}`);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain("Anna");
  });

  it("asks for the bearer token when one is set (not on /health)", async () => {
    const token = "a-long-enough-token-1234";
    const { url } = await start({ env: { NER_TOKEN: token } });
    expect((await post(url, request([SECRET]))).status).toBe(401);
    const wrong = await post(url, request([SECRET]), { authorization: "Bearer a-long-enough-token-1235" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("Bearer");
    expect((await post(url, request([SECRET]), { authorization: `bearer ${token}` })).status).toBe(200);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("answers 429 when too many requests are in progress", async () => {
    const { url } = await start({ env: { NER_MAX_QUEUE: "1" }, core: standInCore({ delayMs: 200 }) });
    const slow = post(url, request(["Anna Lee"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await post(url, request(["Paris"]));
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect((await slow).status).toBe(200);
  });

  it("answers 503 with a fixed message when the model run fails or takes too long", async () => {
    const failing = await start({ core: standInCore({ fail: true }) });
    const failed = await post(failing.url, request([SECRET]));
    expect(failed.status).toBe(503);
    expect(failed.body.error).toEqual({ code: "failed", message: "The model run failed" });
    const slow = await start({ env: { NER_REQUEST_TIMEOUT_MS: "1000" }, core: standInCore({ delayMs: 1_500 }) });
    const timedOut = await post(slow.url, request([SECRET]));
    expect(timedOut.status).toBe(503);
    expect(timedOut.body.error.code).toBe("timeout");
  });
});

describe("the model lifecycle and GET /health", () => {
  it("reports ready with the model once the folder matches the manifest", async () => {
    const { url, service, fake } = await start();
    expect(service.modelState).toBe("ready");
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ready: true, model: { id: fake.model.id, version: expect.any(String), sha256: fake.model.files[0]!.sha256 } });
  });

  it("starts without a model, says how to pull it, and loads it once it is there", async () => {
    const { url, service, fake } = await start({ missing: true });
    const before = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
    expect(before).toMatchObject({ ok: true, ready: false, model: null });
    expect(before.message).toMatch(/models pull example\/fake-gliner --accept-licence/);
    const refused = await post(url, request([SECRET]));
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("not_ready");
    // Pull: write the files, then wait for the next look.
    const folder = path.join(fake.modelsDir, "example__fake-gliner");
    for (const [file, body] of Object.entries(fake.contents)) {
      const full = path.join(folder, file);
      (await import("node:fs")).mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(service.modelState).toBe("ready");
    expect((await post(url, request(["Anna Lee"]))).status).toBe(200);
  });

  it("refuses a folder whose checksums do not match, and says which file", async () => {
    const { url, service } = await start({ corrupt: "tokenizer.json" });
    expect(service.modelState).toBe("invalid");
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, ready: false, model: null });
    expect(body.message).toMatch(/tokenizer\.json/);
  });

  it("checks the folder again when its files change under a loaded model, before a worker restarts", async () => {
    const crash: { trigger?: () => void } = {};
    const { url, service, fake } = await start({ crash });
    expect(service.modelState).toBe("ready");
    // Same size, other content: only the checksum can tell.
    const file = path.join(fake.modelsDir, "example__fake-gliner", "tokenizer.json");
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(file, "[]");
    crash.trigger!();
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(service.modelState).toBe("invalid");
    const health = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: false, ready: false, model: null });
    expect(health.message).toMatch(/tokenizer\.json/);
    expect(JSON.stringify(health)).not.toContain(fake.modelsDir);
  });
});
