/**
 * The names and addresses service as the deployment's recognizer, against a local mock that follows the endpoint
 * contract: request shape, batching, offsets, the contract checks on the answer, errors that never quote texts,
 * timeouts, redirects, the outbound policy, health and the version in the verdict memo key.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ENTITIES_DETECTOR_ID, evaluateGuard, parseGuardProfile, scanSensitiveTextsAsync } from "@ai-orchestrator/guard-sdk";
import { startMockNerEndpoint, MOCK_NER_MODEL, type MockNerEndpoint, type MockNerEndpointOptions } from "../test-support/mock-ner-endpoint.js";
import { createDeploymentGuardRegistry } from "./guard-registry.js";
import { batchesOf, EndpointEntityRecognizer, EntityEndpointError, MAX_RETRIES, piecesOf, retryDelayMs, type EndpointEntityRecognizerOptions, type EntityEndpointOverload } from "./ner-endpoint-recognizer.js";

const servers: MockNerEndpoint[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

const VOCABULARY: MockNerEndpointOptions["vocabulary"] = {
  "Alan Doyle": { label: "person_name", score: 0.97 },
  Oslo: { label: "location", score: 0.9 },
  "42 Dunmore Street": { label: "street_address", score: 0.85 },
  Lund: { label: "location", score: 0.4 }
};

async function serve(options: MockNerEndpointOptions = {}) {
  const server = await startMockNerEndpoint({ vocabulary: VOCABULARY, ...options });
  servers.push(server);
  return server;
}

function recognizerFor(server: { url: string }, options: Partial<EndpointEntityRecognizerOptions> = {}) {
  return new EndpointEntityRecognizer({ baseUrl: server.url, timeoutMs: 2_000, maxRequestChars: 50_000, outbound: { denyPrivate: false, allowlist: [] }, ...options });
}

const ALL = { classes: ["person_name", "location", "street_address"] };

function profileWith(options: Record<string, unknown>, onExceeded: "fail_open" | "fail_closed" = "fail_closed") {
  return parseGuardProfile({
    id: "names",
    name: "Names",
    version: "1",
    latencyBudget: { ms: 2000, onExceeded },
    channels: {
      prompt: {
        detectors: [{ id: ENTITIES_DETECTOR_ID, threshold: 0.5, options }],
        actions: { person_name: { action: "redact" }, street_address: { action: "redact" }, location: { action: "redact" } },
        defaultAction: { action: "allow" }
      }
    }
  });
}

describe("names and addresses service as a recognizer", () => {
  it("sends texts, labels, language and the lowest useful score, with the bearer token, and maps spans back", async () => {
    const server = await serve({ token: "s3cret" });
    const recognizer = recognizerFor(server, { token: "s3cret" });
    const texts = ["Dear Alan Doyle, see you in Oslo.", "", "Ship to 42 Dunmore Street."];
    const spans = await recognizer.recognize(texts, { classes: ["person_name", "location", "street_address"], minScore: 0.5 });
    expect(server.requests).toEqual([{ texts: [texts[0], texts[2]], labels: ["person_name", "location", "street_address"], language: "en", threshold: 0.5 }]);
    expect(server.authorizations).toEqual(["Bearer s3cret"]);
    expect(spans.map((list) => list.map((span) => [texts[spans.indexOf(list)]!.slice(span.start, span.end), span.dataClass, span.score]))).toEqual([
      [
        ["Alan Doyle", "person_name", 0.97],
        ["Oslo", "location", 0.9]
      ],
      [],
      [["42 Dunmore Street", "street_address", 0.85]]
    ]);
    expect(recognizer.version).toBe(`${MOCK_NER_MODEL.id}@${MOCK_NER_MODEL.version}#${MOCK_NER_MODEL.sha256.slice(0, 12)}`);
    expect(recognizer.status()).toMatchObject({ status: "loaded", model: MOCK_NER_MODEL });
  });

  it("takes offsets as UTF-16 code units", async () => {
    const server = await serve();
    const text = "👋🏽 née Ünal: Alan Doyle lives in Oslo";
    const [spans] = await recognizerFor(server).recognize([text], { classes: ["person_name", "location"] });
    expect(spans!.map((span) => text.slice(span.start, span.end))).toEqual(["Alan Doyle", "Oslo"]);
  });

  it("asks only for the labels requested, and sends nothing when none is supported", async () => {
    const server = await serve();
    const [spans] = await recognizerFor(server).recognize(["Alan Doyle in Oslo"], { classes: ["location"] });
    expect(spans!.map((span) => span.dataClass)).toEqual(["location"]);
    expect(server.requests[0]!.labels).toEqual(["location"]);
    expect(await recognizerFor(server).recognize(["Oslo"], { classes: ["email"] })).toEqual([[]]);
    expect(server.requests).toHaveLength(1);
  });

  it("batches many texts into requests of at most 64 texts and the configured characters", async () => {
    const server = await serve();
    const texts = Array.from({ length: 200 }, (_, index) => `row ${index} ${index % 10 === 0 ? "Oslo" : "none"}`);
    const spans = await recognizerFor(server, { maxRequestChars: 2_000 }).recognize(texts, ALL);
    expect(server.requests.length).toBeGreaterThanOrEqual(4);
    for (const request of server.requests) {
      expect(request.texts.length).toBeLessThanOrEqual(64);
      expect(request.texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(2_000);
    }
    expect(spans.map((list) => list.length)).toEqual(texts.map((text) => (text.includes("Oslo") ? 1 : 0)));
  });

  it("splits a long text into overlapping pieces and reports each span once, at its place in the text", async () => {
    const server = await serve({ maxChars: 5_000 });
    let text = "";
    for (let i = 0; text.length < 30_000; i += 1) text += `Note ${i}: Alan Doyle met us in Oslo. `;
    const [spans] = await recognizerFor(server, { maxRequestChars: 5_000 }).recognize([text], ALL);
    const expected: Array<[number, string]> = [];
    for (const phrase of ["Alan Doyle", "Oslo"]) for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) expected.push([at, phrase]);
    expected.sort((a, b) => a[0] - b[0]);
    expect(spans!.map((span) => [span.start, text.slice(span.start, span.end)]).sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual(expected);
    expect(server.requests.every((request) => request.texts.every((piece) => piece.length <= 5_000))).toBe(true);
  });

  it("cuts pieces at white space and gives every position to exactly one piece", () => {
    const text = "word ".repeat(5_000);
    const pieces = piecesOf(text, 0, 4_000);
    expect(pieces[0]!.from).toBe(0);
    expect(pieces[pieces.length - 1]!.to).toBe(text.length);
    for (let i = 1; i < pieces.length; i += 1) {
      expect(pieces[i]!.from).toBe(pieces[i - 1]!.to);
      expect(pieces[i]!.offset).toBeLessThan(pieces[i - 1]!.offset + pieces[i - 1]!.value.length);
      expect(/\s$/.test(pieces[i - 1]!.value)).toBe(true);
    }
    expect(batchesOf(pieces, 9_000).every((batch) => batch.reduce((sum, piece) => sum + piece.value.length, 0) <= 9_000)).toBe(true);
  });

  it("refuses answers that break the contract", async () => {
    const server = await serve();
    const recognizer = recognizerFor(server);
    const cases: Array<[unknown, string]> = [
      [{ results: [], model: MOCK_NER_MODEL }, "different number of results"],
      [{ results: [{ entities: [{ start: 0, end: 99, label: "location", score: 0.9 }] }], model: MOCK_NER_MODEL }, "offsets outside a text"],
      [{ results: [{ entities: [{ start: 0, end: 4, label: "person_name", score: 0.9 }] }], model: MOCK_NER_MODEL }, "label that was not asked for"],
      [{ results: [{ entities: [{ start: 0, end: 4, label: "location", score: 7 }] }], model: MOCK_NER_MODEL }, "does not follow the contract"],
      [{ results: [{ entities: [] }] }, "does not follow the contract"],
      ["not json", "not JSON"]
    ];
    for (const [body, message] of cases) {
      server.answerNext(200, body);
      await expect(recognizer.recognize(["Oslo"], { classes: ["location"] })).rejects.toThrow(message);
      expect(recognizer.status().status).toBe("error");
    }
  });

  it("reports the service's errors by status and code only, never its message or the texts", async () => {
    const server = await serve();
    const recognizer = recognizerFor(server);
    server.answerNext(401, { error: { code: "unauthorized", message: "who is Alan Doyle" } });
    const error = (await recognizer.recognize(["Alan Doyle"], ALL).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(EntityEndpointError);
    expect(error.message).toBe("The names and addresses service answered 401 (unauthorized)");
    server.answerNext(413, { error: { code: "too_large", message: "x" } });
    await expect(recognizer.recognize(["Oslo"], ALL)).rejects.toThrow("answered 413 (too_large)");
    server.answerNext(500, "<html>Alan Doyle</html>");
    await expect(recognizer.recognize(["Oslo"], ALL)).rejects.toThrow(/^The names and addresses service answered 500$/);
    server.set({ ready: false });
    await expect(recognizer.recognize(["Oslo"], ALL)).rejects.toThrow("answered 503 (not_ready)");
    expect(recognizer.status()).toMatchObject({ status: "not_ready" });
    expect(JSON.stringify(recognizer.status())).not.toContain("Alan");
  });

  it("keeps at most maxConcurrent requests in flight, queues a few more, and fails the rest as overloaded", async () => {
    const server = await serve({ delayMs: 150 });
    const overloads: EntityEndpointOverload[] = [];
    const recognizer = recognizerFor(server, { maxConcurrent: 2, onOverload: (event) => overloads.push(event) });
    // 2 in flight + 8 queued (4 per slot) are served; the 11th and 12th find the queue full.
    const calls = Array.from({ length: 12 }, () => recognizer.recognize(["Alan Doyle"], ALL).then(() => "ok", (error: Error) => error.message));
    const outcomes = await Promise.all(calls);
    expect(server.maxInFlight).toBe(2);
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome !== "ok")).toEqual([
      "The names and addresses service is overloaded (2 requests in flight and 8 waiting); names and addresses went unchecked",
      "The names and addresses service is overloaded (2 requests in flight and 8 waiting); names and addresses went unchecked"
    ]);
    expect(overloads).toEqual([{ reason: "queue_full", count: 1 }, { reason: "queue_full", count: 2 }]);
    expect(recognizer.load).toEqual({ active: 0, waiting: 0 });
    expect(recognizer.status().message).toMatch(/^Overloaded 2 times since the API started \(last at .+\); those checks did not check names and addresses/);
  });

  it("fails a request that waits for a slot longer than the request time limit as overloaded, and frees its place", async () => {
    // The first answers at 700 ms and frees the slot for the second; the third is still waiting at 1000 ms.
    const server = await serve({ delayMs: 700 });
    const overloads: EntityEndpointOverload[] = [];
    const recognizer = recognizerFor(server, { maxConcurrent: 1, timeoutMs: 1_000, onOverload: (event) => overloads.push(event) });
    const first = recognizer.recognize(["Alan Doyle"], ALL);
    const second = recognizer.recognize(["Alan Doyle"], ALL);
    const third = recognizer.recognize(["Alan Doyle"], ALL).catch((error: Error) => error.message);
    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(await third).toBe("The names and addresses service is overloaded (no request slot within 1000 ms); names and addresses went unchecked");
    expect(overloads).toEqual([{ reason: "queue_wait", count: 1 }]);
    expect(recognizer.load).toEqual({ active: 0, waiting: 0 });
  });

  it("leaves the queue when the check is stopped while waiting", async () => {
    const server = await serve({ delayMs: 200 });
    const recognizer = recognizerFor(server, { maxConcurrent: 1 });
    const first = recognizer.recognize(["Alan Doyle"], ALL);
    const controller = new AbortController();
    const waiting = recognizer.recognize(["Alan Doyle"], { ...ALL, signal: controller.signal }).catch((error: Error) => error.message);
    controller.abort();
    expect(await waiting).toBe("The names and addresses check was stopped");
    await first;
    expect(server.requests).toHaveLength(1);
    expect(recognizer.load).toEqual({ active: 0, waiting: 0 });
    expect(recognizer.status().message ?? "").not.toContain("Overloaded");
  });

  it("retries a 429 or busy 503 after its Retry-After, and fails as overloaded when the service stays busy", async () => {
    const server = await serve();
    const overloads: EntityEndpointOverload[] = [];
    const recognizer = recognizerFor(server, { onOverload: (event) => overloads.push(event) });
    server.answerNext(429, { error: { code: "rate_limited", message: "slow down Alan Doyle" } }, { "retry-after": "1" });
    server.answerNext(503, { error: { code: "busy", message: "busy" } }, { "retry-after": "0" });
    const started = Date.now();
    const spans = await recognizer.recognize(["Alan Doyle"], ALL);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(spans[0]).toHaveLength(1);
    expect(server.requests).toHaveLength(3);
    expect(overloads).toEqual([]);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) server.answerNext(429, { error: { code: "rate_limited", message: "Alan Doyle" } }, { "retry-after": "0" });
    const error = (await recognizer.recognize(["Alan Doyle"], ALL).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(EntityEndpointError);
    expect(error.message).toBe(`The names and addresses service is overloaded (answered 429 (rate_limited) after ${MAX_RETRIES} retries); names and addresses went unchecked`);
    expect(server.requests).toHaveLength(3 + MAX_RETRIES + 1);
    expect(overloads).toEqual([{ reason: "busy", count: 1 }]);
    expect(JSON.stringify(recognizer.status())).not.toContain("Alan");
  });

  it("caps Retry-After at 5 s and stops waiting when the check is stopped", async () => {
    expect(retryDelayMs("3", 0)).toBe(3_000);
    expect(retryDelayMs("3600", 0)).toBe(5_000);
    expect(retryDelayMs(new Date(2_000).toUTCString(), 0)).toBe(2_000);
    expect(retryDelayMs("soon", 0)).toBe(1_000);
    expect(retryDelayMs(null, 0)).toBe(1_000);
    const server = await serve();
    const recognizer = recognizerFor(server);
    server.answerNext(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "3600" });
    const started = Date.now();
    const error = await recognizer.recognize(["Oslo"], { ...ALL, signal: AbortSignal.timeout(300) }).catch((caught: Error) => caught.message);
    expect(error).toBe("The names and addresses check was stopped");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(server.requests).toHaveLength(1);
  });

  it("fails on a missing or wrong token", async () => {
    const server = await serve({ token: "right" });
    await expect(recognizerFor(server, { token: "wrong" }).recognize(["Oslo"], ALL)).rejects.toThrow("answered 401 (unauthorized)");
    await expect(recognizerFor(server).recognize(["Oslo"], ALL)).rejects.toThrow("answered 401");
  });

  it("gives up after its time limit, and stops when the check is stopped", async () => {
    const server = await serve({ delayMs: 400 });
    const started = Date.now();
    await expect(recognizerFor(server, { timeoutMs: 100 }).recognize(["Oslo"], ALL)).rejects.toThrow("did not answer within 100 ms");
    expect(Date.now() - started).toBeLessThan(380);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    await expect(recognizerFor(server).recognize(["Oslo"], { ...ALL, signal: stop.signal })).rejects.toThrow("was stopped");
  });

  it("reports a time limit hit while the answer is read as a timeout, not as a broken answer", async () => {
    const slowBody = (async () => {
      const http = await import("node:http");
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"results":[');
        // The rest never comes.
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    })();
    const server = await slowBody;
    try {
      const { port } = server.address() as { port: number };
      const recognizer = recognizerFor({ url: `http://127.0.0.1:${port}` }, { timeoutMs: 200 });
      await expect(recognizer.recognize(["Oslo"], ALL)).rejects.toThrow("did not answer within 200 ms");
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 50);
      await expect(recognizerFor({ url: `http://127.0.0.1:${port}` }).recognize(["Oslo"], { ...ALL, signal: stop.signal })).rejects.toThrow("was stopped");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("never follows a redirect", async () => {
    const server = await serve();
    const elsewhere = await serve();
    server.answerNext(307, "", { location: `${elsewhere.url}/v1/entities` });
    await expect(recognizerFor(server).recognize(["Oslo"], ALL)).rejects.toThrow("answered with a redirect, which is never followed");
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("reaches the configured private host with OUTBOUND_DENY_PRIVATE on, and never a metadata address", async () => {
    const server = await serve();
    const strict = recognizerFor(server, { outbound: { denyPrivate: true, allowlist: [] } });
    expect((await strict.recognize(["Oslo"], ALL))[0]).toHaveLength(1);
    const named = new EndpointEntityRecognizer({
      baseUrl: `http://ner.internal:${server.port}`,
      timeoutMs: 2_000,
      maxRequestChars: 50_000,
      outbound: { denyPrivate: true, allowlist: [] },
      resolver: async () => ["127.0.0.1"]
    });
    expect((await named.recognize(["Oslo"], ALL))[0]).toHaveLength(1);
    const metadata = new EndpointEntityRecognizer({ baseUrl: "http://169.254.169.254/", timeoutMs: 500, maxRequestChars: 50_000, outbound: { denyPrivate: false, allowlist: [] } });
    await expect(metadata.recognize(["Oslo"], ALL)).rejects.toThrow("refused by the outbound URL checks (address_blocked)");
    expect(metadata.status().error).toContain("outbound URL checks");
    const rebinding = new EndpointEntityRecognizer({ baseUrl: "http://ner.internal:8080", timeoutMs: 500, maxRequestChars: 50_000, outbound: { denyPrivate: true, allowlist: [] }, resolver: async () => ["169.254.169.254"] });
    await expect(rebinding.recognize(["Oslo"], ALL)).rejects.toThrow("refused by the outbound URL checks");
    // A trailing dot names the same host.
    const dotted = new EndpointEntityRecognizer({ baseUrl: `http://ner.internal.:${server.port}`, timeoutMs: 2_000, maxRequestChars: 50_000, outbound: { denyPrivate: true, allowlist: [] }, resolver: async () => ["127.0.0.1"] });
    expect((await dotted.recognize(["Oslo"], ALL))[0]).toHaveLength(1);
  });

  it("asks for health at most once per interval, and reports ready, not ready and unreachable", async () => {
    let now = 0;
    const server = await serve();
    const recognizer = recognizerFor(server, { now: () => now });
    expect(recognizer.status()).toMatchObject({ status: "not_ready" });
    await recognizer.refreshStatus();
    await recognizer.refreshStatus();
    expect(server.healthChecks).toBe(1);
    expect(recognizer.status()).toMatchObject({ status: "loaded", model: MOCK_NER_MODEL });
    server.set({ ready: false });
    now += 31_000;
    await recognizer.refreshStatus();
    expect(recognizer.status()).toMatchObject({ status: "not_ready", message: "No model is loaded; run l2m models pull" });
    const gone = recognizerFor({ url: "http://127.0.0.1:1" });
    await gone.refreshStatus();
    expect(gone.status()).toMatchObject({ status: "error", error: "The names and addresses service cannot be reached" });
  });
});

describe("the service as the deployment's engine", () => {
  it("finds names and addresses in content rules checks, and the version follows the model", async () => {
    const server = await serve();
    const recognizer = recognizerFor(server);
    const deployment = createDeploymentGuardRegistry({ entityRecognizer: recognizer });
    const verdict = await evaluateGuard(profileWith(ALL), { channel: "prompt", content: "Dear Alan Doyle, we met in Oslo." }, { registry: deployment.registry });
    expect(verdict.findings.map((finding) => [finding.dataClass, finding.evidence])).toEqual([
      ["person_name", "A••• D••••"],
      ["location", "O•••"]
    ]);
    // Lund scores 0.4: the service is asked for spans down to the lowest class minimum, so it is never sent back.
    expect(server.requests[0]!.threshold).toBe(0.7);
    expect(deployment.registry.get(ENTITIES_DETECTOR_ID)!.version).toContain(`endpoint@${MOCK_NER_MODEL.id}@${MOCK_NER_MODEL.version}`);
    expect(deployment.entityEngine()).toMatchObject({ id: "endpoint", kind: "endpoint", status: "loaded", model: MOCK_NER_MODEL });
  });

  it("is timed apart from the latency budget, and a failure follows the rule set's setting", async () => {
    const server = await serve({ delayMs: 50 });
    const deployment = createDeploymentGuardRegistry({ entityRecognizer: recognizerFor(server) });
    // A 1 ms budget would time out an in-budget check; the service's check has its own limit.
    const tight = parseGuardProfile({ ...profileWith(ALL), latencyBudget: { ms: 1, onExceeded: "fail_closed" } });
    const timed = await evaluateGuard(tight, { channel: "prompt", content: "Alan Doyle" }, { registry: deployment.registry });
    expect(timed.timings.detectors[0]!.status).toBe("ran");
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    for (const onExceeded of ["fail_closed", "fail_open"] as const) {
      const verdict = await evaluateGuard(profileWith(ALL, onExceeded), { channel: "prompt", content: "Alan Doyle" }, { registry: deployment.registry });
      expect(verdict.timings.detectors[0]).toMatchObject({ status: "error", error: "Entity recognizer endpoint failed" });
      expect(verdict.action).toBe(onExceeded === "fail_closed" ? "block" : "allow");
    }
  });

  it("unions the built-in rules with the service for engine union, and uses only the rules for engine rules", async () => {
    const server = await serve({ vocabulary: { Zyrtova: { label: "location", score: 0.9 } } });
    const deployment = createDeploymentGuardRegistry({ entityRecognizer: recognizerFor(server) });
    // The rules know the name after its title; only the service knows the (invented) town.
    const text = "Dear Mr. Alan Doyle, we met in Zyrtova.";
    const union = await evaluateGuard(profileWith({ ...ALL, engine: "union" }), { channel: "prompt", content: text }, { registry: deployment.registry });
    expect(union.findings.map((finding) => finding.dataClass).sort()).toEqual(["location", "person_name"]);
    const before = server.requests.length;
    const rules = await evaluateGuard(profileWith({ ...ALL, engine: "rules" }), { channel: "prompt", content: text }, { registry: deployment.registry });
    expect(rules.findings.map((finding) => finding.dataClass)).toEqual(["person_name"]);
    expect(server.requests.length).toBe(before);
  });

  it("checks the strings of a large input in few requests", async () => {
    const server = await serve();
    const recognizer = recognizerFor(server);
    const cells = Array.from({ length: 640 }, (_, index) => (index % 64 === 0 ? `Alan Doyle ${index}` : `cell ${index}`));
    const results = await scanSensitiveTextsAsync(cells, { dictionaries: [] }, { entityTypes: ["person_name"] }, { recognizer });
    expect(server.requests.length).toBe(10);
    expect(results.filter((result) => result.findings.length > 0)).toHaveLength(10);
  });

  it("records names and addresses left unchecked by an overloaded service in the check's timings, under either failure setting", async () => {
    const server = await serve();
    const recognizer = recognizerFor(server);
    const deployment = createDeploymentGuardRegistry({ entityRecognizer: recognizer });
    for (const onExceeded of ["fail_open", "fail_closed"] as const) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) server.answerNext(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "0" });
      const verdict = await evaluateGuard(profileWith(ALL, onExceeded), { channel: "prompt", content: "Alan Doyle" }, { registry: deployment.registry });
      expect(verdict.action).toBe(onExceeded === "fail_closed" ? "block" : "allow");
      expect(verdict.timings.detectors[0]!.status).toBe("error");
    }
    expect(recognizer.status()).toMatchObject({ status: "error", error: expect.stringContaining("overloaded") });
    expect(recognizer.status().message).toMatch(/^Overloaded 2 times/);
  });
});
