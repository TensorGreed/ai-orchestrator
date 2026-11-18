import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadEntityCorpus } from "@ai-orchestrator/guard-sdk";
import { findNerModel, loadNerManifest } from "@ai-orchestrator/ner/models";
import { EXIT_USAGE, main, type CliIo } from "./main";
import { createNerEndpointRecognizer, NerEndpointError, nerEndpointModel } from "./ner-endpoint";

/** A stand-in entity endpoint (no service, no model): it answers the labelled spans of the benchmark corpus. */
const gold = new Map(loadEntityCorpus().items.map((item) => [item.text, item.entities]));
const bundled = findNerModel(loadNerManifest(), undefined);
const bundledModel = { id: bundled.id, version: "test", sha256: bundled.files.find((file) => file.path === bundled.onnx)!.sha256 };
const otherModel = { id: "example/other", version: "1", sha256: "a".repeat(64) };

interface Endpoint {
  fetch: typeof fetch;
  calls: Array<{ url: string; authorization?: string; body?: { texts: string[]; labels: string[] } }>;
}

function endpoint(options: { model?: typeof bundledModel; ready?: boolean; answer?: (body: { texts: string[]; labels: string[] }) => { status: number; json: unknown } } = {}): Endpoint {
  const model = options.model ?? bundledModel;
  const calls: Endpoint["calls"] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as { texts: string[]; labels: string[] }) : undefined;
    calls.push({ url, ...(headers.authorization ? { authorization: headers.authorization } : {}), ...(body ? { body } : {}) });
    if (url.endsWith("/health")) {
      return Response.json(options.ready === false ? { ok: true, ready: false, model: null, message: "Run models pull" } : { ok: true, ready: true, model });
    }
    if (options.answer) {
      const { status, json } = options.answer(body!);
      return Response.json(json, { status });
    }
    const results = body!.texts.map((text) => ({
      entities: (gold.get(text) ?? []).filter((span) => body!.labels.includes(span.dataClass)).map((span) => ({ start: span.start, end: span.end, label: span.dataClass, score: 0.95 }))
    }));
    return Response.json({ results, model });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function io(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}): CliIo & { out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return { stdin: new PassThrough(), stdout, stderr, env, fetch: fetchImpl, out: () => out, err: () => err };
}

const options = (fake: Endpoint) => ({ url: "http://ner.test:8000/", timeoutMs: 1_000, fetch: fake.fetch });

describe("the entity endpoint recognizer", () => {
  it("reads the model from /health and refuses one that is not ready", async () => {
    expect(await nerEndpointModel(options(endpoint()))).toEqual(bundledModel);
    await expect(nerEndpointModel(options(endpoint({ ready: false })))).rejects.toThrow(/not ready: Run models pull/);
  });

  it("refuses an endpoint URL that is not http(s) or carries credentials", async () => {
    const fake = endpoint();
    await expect(nerEndpointModel({ ...options(fake), url: "file:///etc/passwd" })).rejects.toBeInstanceOf(NerEndpointError);
    await expect(nerEndpointModel({ ...options(fake), url: "http://user:pw@ner.test" })).rejects.toThrow(/L2M_NER_TOKEN/);
    expect(fake.calls).toEqual([]);
  });

  it("sends batches of at most 64 texts with the token and maps the spans", async () => {
    const fake = endpoint({
      answer: (body) => ({ status: 200, json: { model: bundledModel, results: body.texts.map((text) => ({ entities: [{ start: 0, end: Math.min(4, text.length), label: "person_name", score: 0.9 }] })) } })
    });
    const recognizer = createNerEndpointRecognizer({ ...options(fake), token: "a-long-enough-token-1234" }, bundledModel);
    const texts = Array.from({ length: 130 }, (_, i) => `Anna ${i}`);
    const spans = await recognizer.recognize(texts, { classes: ["person_name", "email"], language: "en" });
    expect(spans).toHaveLength(130);
    expect(spans[129]).toEqual([{ start: 0, end: 4, dataClass: "person_name", score: 0.9, source: `endpoint:${bundledModel.id}` }]);
    const posts = fake.calls.filter((call) => call.body);
    expect(posts.map((call) => call.body!.texts.length)).toEqual([64, 64, 2]);
    expect(posts[0]!.body!.labels).toEqual(["person_name"]);
    expect(posts[0]!.url).toBe("http://ner.test:8000/v1/entities");
    expect(posts[0]!.authorization).toBe("Bearer a-long-enough-token-1234");
  });

  it.each([
    ["an error status", { status: 503, json: { error: { code: "not_ready", message: "No model" } } }, /refused the request: HTTP 503 not_ready: No model/],
    ["too few results", { status: 200, json: { model: bundledModel, results: [] } }, /does not line up/],
    ["another model", { status: 200, json: { model: otherModel, results: [{ entities: [] }] } }, /another model/],
    ["an entity out of range", { status: 200, json: { model: bundledModel, results: [{ entities: [{ start: 0, end: 99, label: "location", score: 0.9 }] }] } }, /out of range/],
    ["a malformed entity", { status: 200, json: { model: bundledModel, results: [{ entities: [{ start: "0", end: 2, label: "location", score: 0.9 }] }] } }, /malformed/]
  ])("refuses %s", async (_name, answer, message) => {
    const recognizer = createNerEndpointRecognizer(options(endpoint({ answer: () => answer })), bundledModel);
    await expect(recognizer.recognize(["Paris"], { classes: ["location"], language: "en" })).rejects.toThrow(message);
  });

  it("asks nothing when no endpoint label is wanted", async () => {
    const fake = endpoint();
    expect(await createNerEndpointRecognizer(options(fake), bundledModel).recognize(["x"], { classes: ["email"], language: "en" })).toEqual([[]]);
    expect(fake.calls).toEqual([]);
  });
});

describe("l2m guard benchmark --entities --endpoint", () => {
  it("gates a listed model on its manifest floors, with the token from L2M_NER_TOKEN", async () => {
    const fake = endpoint();
    const run = io(fake.fetch, { L2M_NER_TOKEN: "a-long-enough-token-1234" });
    expect(await main(["guard", "benchmark", "--entities", "--endpoint", "http://ner.test:8000"], run)).toBe(0);
    expect(run.out()).toContain(`Measured: ${bundledModel.id} (test) through ner.test:8000`);
    expect(run.out()).toContain(`PASS: every class is at or above ${bundledModel.id}'s floors`);
    expect(fake.calls.every((call) => call.authorization === "Bearer a-long-enough-token-1234")).toBe(true);
  });

  it("only reports for a model the manifest does not list", async () => {
    const run = io(endpoint({ model: otherModel }).fetch);
    expect(await main(["guard", "benchmark", "--entities", "--endpoint", "http://ner.test:8000"], run)).toBe(0);
    expect(run.out()).toContain("No floors are listed for this model");
  });

  it("fails with the reason when the endpoint is not ready, and refuses --endpoint without --entities", async () => {
    const run = io(endpoint({ ready: false }).fetch);
    expect(await main(["guard", "benchmark", "--entities", "--endpoint", "http://ner.test:8000"], run)).toBe(1);
    expect(run.err()).toContain("not ready");
    const usage = io(endpoint().fetch);
    expect(await main(["guard", "benchmark", "--endpoint", "http://ner.test:8000"], usage)).toBe(EXIT_USAGE);
    expect(usage.err()).toContain("--endpoint only applies to --entities");
  });
});

describe("l2m models", () => {
  it("lists the bundled models with their licence", async () => {
    const run = io(endpoint().fetch, { NER_MODEL_DIR: "/nonexistent-l2m-ner-test" });
    expect(await main(["models", "list"], run)).toBe(0);
    expect(run.out()).toContain(`${bundled.id} (default)`);
    expect(run.out()).toContain("Apache-2.0");
    expect(run.out()).toContain("status: not pulled");
  });

  it("refuses to pull without accepting the licence and downloads nothing", async () => {
    const fake = endpoint();
    const run = io(fake.fetch);
    expect(await main(["models", "pull", "--dir", "/nonexistent-l2m-ner-test"], run)).toBe(EXIT_USAGE);
    expect(run.err()).toContain("--accept-licence");
    expect(fake.calls).toEqual([]);
  });
});
