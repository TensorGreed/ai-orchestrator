import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseEntityBenchmarkReport } from "@ai-orchestrator/shared";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, type CliIo } from "./main";

// The runner is measured against a stand-in check that returns the labelled spans, so these tests pin the command,
// not the rules engine (whose floors the guard-sdk gate and the CI step pin).
vi.mock("@ai-orchestrator/guard-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-orchestrator/guard-sdk")>();
  const gold = new Map(actual.loadEntityCorpus().items.map((item) => [item.text, item.entities]));
  return {
    ...actual,
    entityBenchmarkRegistry: () =>
      new actual.GuardRegistry().register({
        id: "data.entities",
        tier: "classifier",
        description: "test stand-in",
        channels: ["prompt"],
        categories: ["sensitive_data"],
        detect: (_input, context) =>
          (gold.get(context.text) ?? []).map((span) => ({
            detectorId: "data.entities",
            category: "sensitive_data",
            dataClass: span.dataClass,
            score: 0.9,
            spans: [{ start: span.start, end: span.end }],
            evidence: "***",
            message: "stand-in"
          }))
      }),
    ENTITY_RULES_BENCHMARK_FLOORS: {
      person_name: { main: { precision: 1, recall: 1 }, heldout: { precision: 1, recall: 1 } },
      location: { main: { precision: 1, recall: 1 }, heldout: { precision: 1, recall: 1 } },
      street_address: { main: { precision: 1, recall: 1 } }
    }
  };
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-cli-entities-"));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));
const file = (name: string) => path.join(tempDir, name);

function io(): CliIo & { out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return { stdin: new PassThrough(), stdout, stderr, env: {}, out: () => out, err: () => err };
}

describe("l2m guard benchmark --entities", () => {
  it("gates on the floors, fails a class without one and prints the floors to set", async () => {
    const run = io();
    expect(await main(["guard", "benchmark", "--entities", "--out", file("entities.json"), "--junit", file("entities.xml")], run)).toBe(EXIT_FAILED);
    expect(run.out()).toContain("street_address (heldout): no floor set");
    expect(run.out()).toContain("Set ENTITY_RULES_BENCHMARK_FLOORS");
    expect(run.out()).toMatch(/person_name\s+main\s+precision 100\.0%/);
    const report = parseEntityBenchmarkReport(JSON.parse(fs.readFileSync(file("entities.json"), "utf8")));
    expect(report.corpus.items).toBe(420);
    expect(fs.statSync(file("entities.json")).mode & 0o777).toBe(0o600);
    const junit = fs.readFileSync(file("entities.xml"), "utf8");
    expect(junit).toContain('tests="7" failures="1"');
    expect(junit).toContain('name="street_address (heldout)"');
  });

  it("passes on one split where every class has a floor", async () => {
    const run = io();
    expect(await main(["guard", "benchmark", "--entities", "--split", "main", "--json"], run)).toBe(EXIT_OK);
    const body = JSON.parse(run.out()) as { ok: boolean; gate: string; report: { results: unknown[] } };
    expect(body).toMatchObject({ ok: true, gate: "floors" });
    expect(body.report.results).toHaveLength(3);
  });

  it("measures a rule set's own options without a gate, and refuses one without the check", async () => {
    const names = file("names.json");
    fs.writeFileSync(names, JSON.stringify({ document: { id: "names", name: "Names", version: "4", channels: { prompt: { detectors: [{ id: "data.entities", options: { classes: ["person_name"] } }] } } } }));
    const run = io();
    expect(await main(["guard", "benchmark", "--entities", "--profile", names], run)).toBe(EXIT_OK);
    expect(run.out()).toContain("No gate");
    expect(run.out()).not.toContain("street_address");

    const none = file("none.json");
    fs.writeFileSync(none, JSON.stringify({ id: "none", name: "None", version: "1", channels: {} }));
    const refused = io();
    expect(await main(["guard", "benchmark", "--entities", "--profile", none], refused)).toBe(EXIT_USAGE);
    expect(refused.err()).toContain("does not list the data.entities check");
  });

  it("refuses red-team flags and unknown splits", async () => {
    for (const extra of [["--builtin"], ["--category", "jailbreak"], ["--suite", "workflow"], ["--split", "test"]]) {
      const run = io();
      expect(await main(["guard", "benchmark", "--entities", ...extra], run)).toBe(EXIT_USAGE);
    }
  });
});
