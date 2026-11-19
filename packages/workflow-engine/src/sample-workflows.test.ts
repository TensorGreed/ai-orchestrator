/**
 * Every sample in samples/workflows/ and every starter template in samples/starters/ (with the companion workflows a
 * starter brings) must import: the same parse and graph validation that POST /api/workflows/import runs
 * (importWorkflowFromJson, then validateWorkflowGraph).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importWorkflowFromJson } from "./serialization.js";
import { validateWorkflowGraph } from "./validation.js";

const SAMPLES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "samples");
const SAMPLES = path.join(SAMPLES_ROOT, "workflows");
const STARTERS = path.join(SAMPLES_ROOT, "starters");
const files = fs.readdirSync(SAMPLES).filter((file) => file.endsWith(".json")).sort();
const starterFiles = fs.readdirSync(STARTERS).filter((file) => file.endsWith(".json")).sort();

function expectValid(raw: string) {
  const workflow = importWorkflowFromJson(raw);
  const validation = validateWorkflowGraph(workflow);
  expect(validation.issues.map((issue) => issue.message)).toEqual([]);
  expect(validation.valid).toBe(true);
}

describe("sample workflows", () => {
  it("finds the samples folder", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports without validation errors", (file) => {
    expectValid(fs.readFileSync(path.join(SAMPLES, file), "utf8"));
  });
});

describe("starter templates", () => {
  it("finds the starters folder", () => {
    expect(starterFiles.length).toBeGreaterThan(0);
  });

  it.each(starterFiles)("%s and its companions import without validation errors", (file) => {
    // The API base URL token is filled in when the starters are seeded.
    const raw = fs.readFileSync(path.join(STARTERS, file), "utf8").split("$L2M_API_BASE").join("http://127.0.0.1:4000");
    expectValid(raw);
    const companions = (JSON.parse(raw) as { companions?: unknown[] }).companions ?? [];
    for (const companion of companions) expectValid(JSON.stringify(companion));
  });
});
