import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { evaluateGuard } from "./evaluate";
import { guardCorpusDir } from "./benchmark";
import { OUTPUT_CHECK_DETECTOR_IDS } from "./output-checks";
import { parseGuardProfile, type GuardProfile } from "./profile";
import type { GuardRegistry } from "./registry";
import { createDefaultGuardRegistry } from "./index";
import { stableStringify, type GuardInput } from "./types";

/**
 * Phase 12 coverage — a small benchmark for the output checks (answer schema, topics, content safety, grounding).
 *
 * The red-team corpus measures a rule set someone hands in. These checks only mean something with options (a schema,
 * a topic list, sources), so each file here carries its own check and options, and the benchmark builds one rule set
 * per file around them. Every check runs in its local mode: phrase topics, the built-in safety rules and lexical
 * grounding, with no model and no network, so results are deterministic. Items are answers a model might give, with
 * the documents a grounding item was drawn from.
 */

const sourceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citation: z.number().int().positive().optional(),
  title: z.string().optional()
});

const itemSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.enum(["attack", "benign"]),
  content: z.string().min(1),
  note: z.string().optional(),
  sources: z.array(sourceSchema).optional()
});

const fileSchema = z.object({
  category: z.string().min(1).max(64),
  check: z.enum(OUTPUT_CHECK_DETECTOR_IDS),
  description: z.string().optional(),
  owasp: z.array(z.string()).default([]),
  options: z.record(z.string(), z.unknown()).default({}),
  sources: z.array(sourceSchema).optional(),
  items: z.array(itemSchema).min(1)
});

export type OutputCheckCorpusItem = z.infer<typeof itemSchema>;
export type OutputCheckCorpusFile = z.infer<typeof fileSchema> & { file: string };

export interface OutputCheckCorpus {
  files: OutputCheckCorpusFile[];
  /** SHA-256 over every file's canonical JSON, in file order. */
  hash: string;
}

/** The output check corpus that ships with guard-sdk (`corpus/output-checks/`). */
export function outputCheckCorpusDir(): string {
  return join(guardCorpusDir(), "output-checks");
}

/** Validate output check corpus files; throws with the file and the issues listed. Ids must be unique. */
export function parseOutputCheckCorpus(entries: Array<{ file: string; document: unknown }>): OutputCheckCorpus {
  const files: OutputCheckCorpusFile[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const result = fileSchema.safeParse(entry.document);
    if (!result.success) {
      throw new Error(`Invalid output check corpus file ${entry.file}: ${result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    }
    for (const item of result.data.items) {
      if (seen.has(item.id)) throw new Error(`Duplicate output check corpus item id '${item.id}' in ${entry.file}`);
      seen.add(item.id);
    }
    files.push({ ...result.data, file: entry.file });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.file}\n${stableStringify(file)}\n`);
  return { files, hash: hash.digest("hex") };
}

/** Read and validate the output check corpus (`*.json` in the directory). */
export function loadOutputCheckCorpus(dir: string = outputCheckCorpusDir()): OutputCheckCorpus {
  const documents = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((file) => ({ file, document: JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown }))
    : [];
  return parseOutputCheckCorpus(documents);
}

/** The rule set a corpus file is measured with: its check alone on `final_output`, blocking its category. */
export function outputCheckBenchmarkProfile(file: Pick<OutputCheckCorpusFile, "category" | "check" | "options">): GuardProfile {
  return parseGuardProfile({
    id: `output-benchmark-${file.category}`,
    name: `Output check benchmark: ${file.category}`,
    version: "1",
    // A generous budget: the local checks take milliseconds, and a slow host must not turn a benign item into a catch.
    latencyBudget: { ms: 60_000, onExceeded: "fail_closed" },
    channels: {
      final_output: {
        detectors: [{ id: file.check, options: file.options }],
        actions: { [file.category]: { action: "block" } },
        defaultAction: { action: "block" }
      }
    }
  });
}

export interface OutputCheckItemOutcome {
  id: string;
  category: string;
  label: "attack" | "benign";
  caught: boolean;
}

export interface OutputCheckCategoryResult {
  category: string;
  check: string;
  attacks: { total: number; caught: number; missed: string[] };
  benign: { total: number; flagged: number; flaggedIds: string[] };
}

export interface OutputCheckBenchmarkReport {
  corpusHash: string;
  categories: OutputCheckCategoryResult[];
}

/**
 * Run every corpus item through its file's rule set. "Caught" means the verdict is anything but `allow`; a check that
 * fails to run counts as caught too (the rule set fails closed), so a broken check shows up as false positives.
 */
export async function runOutputCheckBenchmark(
  options: { corpus?: OutputCheckCorpus; registry?: GuardRegistry } = {}
): Promise<{ report: OutputCheckBenchmarkReport; items: OutputCheckItemOutcome[] }> {
  const corpus = options.corpus ?? loadOutputCheckCorpus();
  const registry = options.registry ?? createDefaultGuardRegistry();
  const items: OutputCheckItemOutcome[] = [];
  const categories: OutputCheckCategoryResult[] = [];
  for (const file of corpus.files) {
    const profile = outputCheckBenchmarkProfile(file);
    const result: OutputCheckCategoryResult = {
      category: file.category,
      check: file.check,
      attacks: { total: 0, caught: 0, missed: [] },
      benign: { total: 0, flagged: 0, flaggedIds: [] }
    };
    for (const item of file.items) {
      const sources = item.sources ?? file.sources;
      const input: GuardInput = { channel: "final_output", content: item.content, ...(sources ? { sources } : {}) };
      const verdict = await evaluateGuard(profile, input, { registry });
      const caught = verdict.action !== "allow";
      items.push({ id: item.id, category: file.category, label: item.label, caught });
      if (item.label === "attack") {
        result.attacks.total += 1;
        if (caught) result.attacks.caught += 1;
        else result.attacks.missed.push(item.id);
      } else {
        result.benign.total += 1;
        if (caught) {
          result.benign.flagged += 1;
          result.benign.flaggedIds.push(item.id);
        }
      }
    }
    categories.push(result);
  }
  return { report: { corpusHash: corpus.hash, categories }, items };
}
