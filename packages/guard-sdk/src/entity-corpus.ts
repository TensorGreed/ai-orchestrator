import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ENTITY_BENCHMARK_CLASSES, GUARD_BENCHMARK_SPLITS, type EntityBenchmarkClass, type GuardBenchmarkSplit } from "@ai-orchestrator/shared";
import { guardCorpusDir } from "./benchmark";
import { ENTITY_CORPUS_FORMAT } from "./entity-corpus-generator";
import { stableStringify } from "./types";

/**
 * The span-annotated entity corpus (`corpus/entities/main.json`, `corpus/entities/heldout/*.json`): person names,
 * places and street addresses with their character offsets. The red-team loader reads only top-level and `heldout/`
 * files of `corpus/`, so this folder changes neither its corpus nor its hash.
 */

const spanSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), class: z.enum(ENTITY_BENCHMARK_CLASSES) });

const itemSchema = z.object({
  id: z.string().min(1).max(64),
  lang: z.string().min(2).max(16),
  tags: z.array(z.string()).default([]),
  /** base64 of the UTF-8 text; offsets are UTF-16 code units of the decoded text, as JavaScript strings count them. */
  textB64: z.string(),
  entities: z.array(spanSchema)
});

const fileSchema = z.object({
  format: z.literal(ENTITY_CORPUS_FORMAT),
  version: z.literal(1),
  split: z.enum(GUARD_BENCHMARK_SPLITS),
  description: z.string().optional(),
  source: z.string().min(1),
  items: z.array(itemSchema).min(1)
});

export interface EntityCorpusSpanLabel {
  start: number;
  end: number;
  dataClass: EntityBenchmarkClass;
}

export interface EntityCorpusItem {
  id: string;
  split: GuardBenchmarkSplit;
  lang: string;
  tags: string[];
  text: string;
  entities: EntityCorpusSpanLabel[];
}

export interface EntityCorpus {
  items: EntityCorpusItem[];
  /** SHA-256 over every item's canonical JSON (decoded text), in split and file order. */
  hash: string;
}

/** The entity corpus folder that ships with guard-sdk. */
export function entityCorpusDir(): string {
  return join(guardCorpusDir(), "entities");
}

function decodeText(encoded: string): string {
  const binary = atob(encoded);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** Validate entity corpus files; throws with the file and the problem. Ids are unique; spans lie inside the text, do not overlap and have no outer whitespace. */
export function parseEntityCorpus(entries: Array<{ file: string; document: unknown }>): EntityCorpus {
  const items: EntityCorpusItem[] = [];
  const seen = new Set<string>();
  const ordered: Array<{ file: string; split: GuardBenchmarkSplit; items: EntityCorpusItem[] }> = [];
  for (const entry of entries) {
    const result = fileSchema.safeParse(entry.document);
    if (!result.success) {
      throw new Error(`Invalid entity corpus file ${entry.file}: ${result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    }
    const split = result.data.split;
    const fileItems = result.data.items.map((raw) => {
      if (seen.has(raw.id)) throw new Error(`Duplicate entity corpus item id '${raw.id}' in ${entry.file}`);
      seen.add(raw.id);
      let text: string;
      try {
        text = decodeText(raw.textB64);
      } catch {
        throw new Error(`Entity corpus item '${raw.id}' in ${entry.file} has an undecodable textB64`);
      }
      const spans = [...raw.entities].sort((a, b) => a.start - b.start);
      let previousEnd = 0;
      for (const span of spans) {
        const value = text.slice(span.start, span.end);
        if (span.end <= span.start || span.end > text.length) throw new Error(`Entity corpus item '${raw.id}': span ${span.start}-${span.end} lies outside the text`);
        if (span.start < previousEnd) throw new Error(`Entity corpus item '${raw.id}': spans overlap at ${span.start}`);
        if (value.trim() !== value) throw new Error(`Entity corpus item '${raw.id}': span ${span.start}-${span.end} has outer whitespace`);
        previousEnd = span.end;
      }
      return { id: raw.id, split, lang: raw.lang, tags: raw.tags, text, entities: spans.map((span) => ({ start: span.start, end: span.end, dataClass: span.class })) };
    });
    ordered.push({ file: entry.file, split, items: fileItems });
  }
  ordered.sort((a, b) => GUARD_BENCHMARK_SPLITS.indexOf(a.split) - GUARD_BENCHMARK_SPLITS.indexOf(b.split) || a.file.localeCompare(b.file));
  const hash = createHash("sha256");
  for (const file of ordered) {
    hash.update(`${file.split}/${file.file}\n`);
    for (const item of file.items) hash.update(`${stableStringify(item)}\n`);
    items.push(...file.items);
  }
  return { items, hash: hash.digest("hex") };
}

let cached: { dir: string; corpus: EntityCorpus } | undefined;

/** Read and validate the entity corpus: `*.json` in the folder and in `heldout/` (each file names its split). Cached per folder. */
export function loadEntityCorpus(dir: string = entityCorpusDir()): EntityCorpus {
  if (cached?.dir === dir) return cached.corpus;
  const read = (folder: string, prefix: string) =>
    existsSync(folder)
      ? readdirSync(folder)
          .filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"))
          .sort()
          .map((file) => ({ file: `${prefix}${file}`, document: JSON.parse(readFileSync(join(folder, file), "utf8")) as unknown }))
      : [];
  const corpus = parseEntityCorpus([...read(dir, ""), ...read(join(dir, "heldout"), "heldout/")]);
  cached = { dir, corpus };
  return corpus;
}
