/**
 * Every sample in samples/workflows/ must import: the same parse and graph validation that
 * POST /api/workflows/import runs (importWorkflowFromJson, then validateWorkflowGraph).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importWorkflowFromJson } from "./serialization.js";
import { validateWorkflowGraph } from "./validation.js";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "samples", "workflows");
const files = fs.readdirSync(SAMPLES).filter((file) => file.endsWith(".json")).sort();

describe("sample workflows", () => {
  it("finds the samples folder", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports without validation errors", (file) => {
    const workflow = importWorkflowFromJson(fs.readFileSync(path.join(SAMPLES, file), "utf8"));
    const validation = validateWorkflowGraph(workflow);
    expect(validation.issues.map((issue) => issue.message)).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});
