import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The model manifest (`models.json`): which models l2m-ner can run, where their files come from (the publisher's
 * own URLs, pinned to a revision), the SHA-256 and size of every file, the licence and what is known about the
 * training data, and the per-model settings the service needs (window size, prompts, thresholds). L2M never ships
 * model weights: `models pull` downloads them from the publisher and checks every file against this manifest, and
 * the service refuses a model folder whose files do not match.
 */

export const NER_ENTITY_CLASSES = ["person_name", "location", "street_address"] as const;
export type NerEntityClass = (typeof NER_ENTITY_CLASSES)[number];

/** A path inside a model folder: plain segments only (no `..`, no absolute path, no backslash). */
const relativePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/, "a relative path of plain segments")
  .refine((value) => !value.split("/").some((segment) => segment === "." || segment === ".."), "no . or .. segments");

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters");
const rate = z.number().min(0).max(1);

const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "an https URL without credentials");

export const nerModelFileSchema = z
  .object({
    path: relativePath,
    url: httpsUrl,
    sha256,
    bytes: z.number().int().positive().max(8 * 1024 ** 3)
  })
  .strict();

/**
 * One prompt (GLiNER label) sent to the model. `class` is what a span of this label is reported as; `null` means
 * the label is only used to build street addresses (a postcode alone is never reported). `addressPart` labels next
 * to a street are merged into one `street_address` span. `threshold` is the model's own cut-off for this label,
 * calibrated with the entity benchmark: a raw score at the threshold is reported as `NER_CALIBRATED_CUT`. Next to
 * a street the context makes a part more likely, so a part may join an address at a lower `joinThreshold`.
 */
export const nerPromptSchema = z
  .object({
    prompt: z.string().trim().min(1).max(64),
    class: z.enum(NER_ENTITY_CLASSES).nullable(),
    addressPart: z.boolean().default(false),
    threshold: z.number().gt(0).lt(1),
    /** Address parts only: the raw score at which a part next to a street joins its address (default: `threshold`). */
    joinThreshold: z.number().gt(0).lt(1).optional()
  })
  .strict();

const floorPair = z.object({ precision: rate, recall: rate }).strict();
const classFloors = z.object({ main: floorPair.optional(), heldout: floorPair.optional() }).strict();

export const nerModelSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/, "publisher/name"),
    name: z.string().min(1).max(120),
    publisher: z.string().min(1).max(200),
    homepage: httpsUrl,
    /** The publisher's revision (commit) the files are pinned to. */
    revision: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
    licence: z
      .object({
        id: z.string().min(1).max(64),
        url: httpsUrl,
        trainingData: z.string().min(1).max(500),
        notes: z.string().max(1000).optional()
      })
      .strict(),
    architecture: z.literal("gliner"),
    files: z.array(nerModelFileSchema).min(1).max(32),
    onnx: relativePath,
    tokenizer: relativePath,
    tokenizerConfig: relativePath,
    glinerConfig: relativePath,
    languages: z.array(z.string().regex(/^[a-z]{2}$/)).min(1).max(32),
    window: z
      .object({
        words: z.number().int().min(16).max(384).default(128),
        overlap: z.number().int().min(0).max(64).default(16),
        /** Subtokens per window, prompt included; a window ends early rather than pass this. */
        maxTokens: z.number().int().min(64).max(2048).default(512),
        /** Subtokens kept per word: a very long "word" (a hash, a run of letters) is cut, not sent whole. */
        maxWordTokens: z.number().int().min(1).max(64).default(16)
      })
      .strict()
      .default({ words: 128, overlap: 16, maxTokens: 512, maxWordTokens: 16 }),
    prompts: z.array(nerPromptSchema).min(1).max(16),
    /** Most characters between a street and the next address part (city, state, postcode) that still joins them. */
    addressMaxGap: z.number().int().min(0).max(16).default(6),
    /** Benchmark floors for this model (overlap matching), checked by `l2m guard benchmark --entities --endpoint`. */
    benchmarkFloors: z
      .object({ person_name: classFloors.optional(), location: classFloors.optional(), street_address: classFloors.optional() })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((model, ctx) => {
    const paths = new Set<string>();
    for (const file of model.files) {
      if (paths.has(file.path)) ctx.addIssue({ code: "custom", message: `file ${file.path} is listed twice`, path: ["files"] });
      paths.add(file.path);
    }
    for (const key of ["onnx", "tokenizer", "tokenizerConfig", "glinerConfig"] as const) {
      if (!paths.has(model[key])) ctx.addIssue({ code: "custom", message: `${key} (${model[key]}) is not one of the files`, path: [key] });
    }
    if (model.window.overlap >= model.window.words / 2) ctx.addIssue({ code: "custom", message: "window.overlap must be under half of window.words", path: ["window", "overlap"] });
    const prompts = new Set<string>();
    for (const prompt of model.prompts) {
      if (prompts.has(prompt.prompt)) ctx.addIssue({ code: "custom", message: `prompt "${prompt.prompt}" is listed twice`, path: ["prompts"] });
      prompts.add(prompt.prompt);
      if (prompt.class === null && !prompt.addressPart) ctx.addIssue({ code: "custom", message: `prompt "${prompt.prompt}" has no class and is not an address part`, path: ["prompts"] });
      if (prompt.joinThreshold !== undefined && !prompt.addressPart) ctx.addIssue({ code: "custom", message: `prompt "${prompt.prompt}" has a joinThreshold but is not an address part`, path: ["prompts"] });
    }
  });

export const nerManifestSchema = z
  .object({
    format: z.literal("l2m.ner-models"),
    version: z.literal(1),
    default: z.string().min(1).max(128),
    models: z.array(nerModelSchema).min(1).max(64)
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    for (const model of manifest.models) {
      if (ids.has(model.id)) ctx.addIssue({ code: "custom", message: `model ${model.id} is listed twice`, path: ["models"] });
      ids.add(model.id);
    }
    if (!ids.has(manifest.default)) ctx.addIssue({ code: "custom", message: `default model ${manifest.default} is not listed`, path: ["default"] });
  });

export type NerModelFile = z.output<typeof nerModelFileSchema>;
export type NerPrompt = z.output<typeof nerPromptSchema>;
export type NerModel = z.output<typeof nerModelSchema>;
export type NerManifest = z.output<typeof nerManifestSchema>;

/** The bundled manifest, next to this package's package.json (in the image: /app/models.json). */
export function bundledManifestPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/models/manifest.ts and dist/models/manifest.js are both two levels below the package root.
  return path.resolve(here, "..", "..", "models.json");
}

export function parseNerManifest(raw: unknown, source = "manifest"): NerManifest {
  const parsed = nerManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`${source} is not a valid model manifest: ${problems.join("; ")}`);
  }
  return parsed.data;
}

/** Reads and validates a manifest file (default: the bundled one). Manifests are small; anything over 1 MiB is refused. */
export function loadNerManifest(file: string = bundledManifestPath()): NerManifest {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the model manifest ${file}: ${(error as NodeJS.ErrnoException).code ?? "read error"}`);
  }
  if (text.length > 1024 * 1024) throw new Error(`The model manifest ${file} is larger than 1 MiB`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`The model manifest ${file} is not JSON`);
  }
  return parseNerManifest(raw, file);
}

export function findNerModel(manifest: NerManifest, id: string | undefined): NerModel {
  const wanted = id ?? manifest.default;
  const model = manifest.models.find((entry) => entry.id === wanted);
  if (!model) throw new Error(`Model ${JSON.stringify(wanted.slice(0, 128))} is not in the manifest (known: ${manifest.models.map((entry) => entry.id).join(", ")})`);
  return model;
}

/** The folder a model lives in under the models directory: its id with `/` written as `__`. */
export function nerModelFolderName(model: Pick<NerModel, "id">): string {
  return model.id.replace("/", "__");
}

export function nerModelFolder(modelsDir: string, model: Pick<NerModel, "id">): string {
  return path.join(modelsDir, nerModelFolderName(model));
}

/** A file's absolute path inside the model folder; throws if the manifest path would leave it. */
export function nerModelFilePath(folder: string, relative: string): string {
  const resolved = path.resolve(folder, ...relative.split("/"));
  const root = path.resolve(folder) + path.sep;
  if (!resolved.startsWith(root)) throw new Error(`Manifest path ${relative} leaves the model folder`);
  return resolved;
}

/** The manifest's file entry for a path (the onnx file, a tokenizer file). */
export function nerModelFile(model: NerModel, relative: string): NerModelFile {
  const file = model.files.find((entry) => entry.path === relative);
  if (!file) throw new Error(`${relative} is not one of the model's files`);
  return file;
}

/** The manifest entry for a running model: same id and the same ONNX file (by SHA-256), or undefined. */
export function findModelByChecksum(manifest: NerManifest, id: string, onnxSha256: string): NerModel | undefined {
  return manifest.models.find((model) => model.id === id && model.files.some((file) => file.path === model.onnx && file.sha256 === onnxSha256));
}
