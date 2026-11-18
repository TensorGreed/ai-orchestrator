import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * l2m-ner settings, from the environment. Every one has a safe default; the service starts without a model and
 * reports `ready: false` until one is pulled into NER_MODEL_DIR.
 */

const int = (min: number, max: number, fallback: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, "a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);

const envSchema = z.object({
  NER_HOST: z.string().trim().min(1).max(255).optional().default("127.0.0.1"),
  NER_PORT: int(1, 65_535, 8000),
  NER_MODEL_DIR: z.string().trim().min(1).max(4096).optional().default("ner-models"),
  NER_MODEL: z.string().trim().min(1).max(128).optional(),
  NER_MANIFEST: z.string().trim().min(1).max(4096).optional(),
  NER_TOKEN: z.string().optional(),
  NER_TOKEN_FILE: z.string().trim().min(1).max(4096).optional(),
  NER_WORKERS: int(0, 16, 1),
  NER_THREADS: int(1, 64, 2),
  NER_MAX_QUEUE: int(1, 1_000, 16),
  NER_REQUEST_TIMEOUT_MS: int(1_000, 600_000, 60_000),
  NER_MAX_TEXT_CHARS: int(1, 1_000_000, 20_000),
  NER_MAX_REQUEST_CHARS: int(1, 10_000_000, 200_000),
  NER_MAX_BODY_BYTES: int(1_024, 64 * 1024 * 1024, 2 * 1024 * 1024),
  NER_MODEL_RETRY_MS: int(1_000, 3_600_000, 15_000)
});

export interface NerConfig {
  host: string;
  port: number;
  modelsDir: string;
  modelId: string | undefined;
  manifestFile: string | undefined;
  /** Bearer token callers must send; undefined = no token asked for. */
  token: string | undefined;
  workers: number;
  threads: number;
  maxQueue: number;
  requestTimeoutMs: number;
  maxTextChars: number;
  maxRequestChars: number;
  maxBodyBytes: number;
  modelRetryMs: number;
}

/** Shortest token accepted: a short shared secret on an internal network is guessable. */
export const NER_MIN_TOKEN_LENGTH = 16;

export function loadNerConfig(env: NodeJS.ProcessEnv = process.env): NerConfig {
  const blankToUndefined = Object.fromEntries(Object.entries(env).filter(([key, value]) => key.startsWith("NER_") && value !== undefined && value.trim() !== ""));
  const parsed = envSchema.safeParse(blankToUndefined);
  if (!parsed.success) {
    // Names and reasons only: a value (a token) is never printed.
    throw new Error(`Invalid l2m-ner settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const values = parsed.data;
  if (values.NER_TOKEN !== undefined && values.NER_TOKEN_FILE !== undefined) throw new Error("Invalid l2m-ner settings: set NER_TOKEN or NER_TOKEN_FILE, not both");
  let token = values.NER_TOKEN?.trim();
  if (values.NER_TOKEN_FILE !== undefined) {
    try {
      token = readFileSync(values.NER_TOKEN_FILE, "utf8").trim();
    } catch (error) {
      throw new Error(`Invalid l2m-ner settings: NER_TOKEN_FILE cannot be read (${(error as NodeJS.ErrnoException).code ?? "read error"})`);
    }
  }
  if (token !== undefined) {
    if (token.length < NER_MIN_TOKEN_LENGTH) throw new Error(`Invalid l2m-ner settings: the token must be at least ${NER_MIN_TOKEN_LENGTH} characters`);
    if (token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new Error("Invalid l2m-ner settings: the token must be printable ASCII without spaces, at most 4096 characters");
  }
  if (values.NER_MAX_TEXT_CHARS > values.NER_MAX_REQUEST_CHARS) throw new Error("Invalid l2m-ner settings: NER_MAX_TEXT_CHARS is larger than NER_MAX_REQUEST_CHARS");
  return {
    host: values.NER_HOST,
    port: values.NER_PORT,
    modelsDir: path.resolve(values.NER_MODEL_DIR),
    modelId: values.NER_MODEL,
    manifestFile: values.NER_MANIFEST ? path.resolve(values.NER_MANIFEST) : undefined,
    token,
    workers: values.NER_WORKERS,
    threads: values.NER_THREADS,
    maxQueue: values.NER_MAX_QUEUE,
    requestTimeoutMs: values.NER_REQUEST_TIMEOUT_MS,
    maxTextChars: values.NER_MAX_TEXT_CHARS,
    maxRequestChars: values.NER_MAX_REQUEST_CHARS,
    maxBodyBytes: values.NER_MAX_BODY_BYTES,
    modelRetryMs: values.NER_MODEL_RETRY_MS
  };
}
