import { readFile } from "node:fs/promises";
import { GlinerCore, type GlinerSession, type MakeTensor } from "./gliner.js";
import { nerModelFilePath, type NerModel } from "./models/manifest.js";

/**
 * Loads a GLiNER model folder (already checked against the manifest) into ONNX Runtime (native CPU) and the
 * tokenizer. Used inside each worker thread. Only the onnxruntime-node CPU execution provider is used; nothing is
 * downloaded.
 */

export interface EngineSettings {
  /** ONNX Runtime intra-op threads per worker. */
  intraOpThreads: number;
}

interface TokenizerConfigFile {
  added_tokens_decoder?: Record<string, { content?: string }>;
}

interface GlinerConfigFile {
  max_width?: number;
  ent_token?: string;
  sep_token?: string;
  class_token_index?: number;
  span_mode?: string;
}

async function readJson<T>(file: string, what: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    throw new Error(`The model's ${what} could not be read as JSON`);
  }
}

/**
 * ONNX Runtime's Linux builds carry a usage-telemetry client; it is switched off before the native library loads
 * (the variable is read once, at load). l2m-ner sends nothing anywhere: it only answers requests.
 */
export function disableRuntimeTelemetry(): void {
  process.env.ORT_DISABLE_TELEMETRY = "1";
}

export async function loadGlinerEngine(folder: string, model: NerModel, settings: EngineSettings): Promise<GlinerCore> {
  disableRuntimeTelemetry();
  const [{ Tokenizer }, ort] = await Promise.all([import("@huggingface/tokenizers"), import("onnxruntime-node")]);
  const tokenizerJson = await readJson<object>(nerModelFilePath(folder, model.tokenizer), "tokenizer");
  const tokenizerConfig = await readJson<TokenizerConfigFile>(nerModelFilePath(folder, model.tokenizerConfig), "tokenizer config");
  const glinerConfig = await readJson<GlinerConfigFile>(nerModelFilePath(folder, model.glinerConfig), "GLiNER config");
  if (glinerConfig.span_mode !== undefined && glinerConfig.span_mode !== "markerV0") {
    throw new Error(`Unsupported GLiNER span mode ${String(glinerConfig.span_mode).slice(0, 40)} (this service decodes markerV0 span models)`);
  }
  const maxWidth = glinerConfig.max_width;
  if (!Number.isInteger(maxWidth) || maxWidth! < 1 || maxWidth! > 32) throw new Error("The GLiNER config has no usable max_width");
  // Then an entity cut by a window's end always lies whole in the next window (see resolveCandidates).
  if (model.window.overlap < maxWidth!) throw new Error(`window.overlap (${model.window.overlap}) must be at least the model's max_width (${maxWidth})`);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig as object);
  const idOf = (token: string | undefined, what: string): number => {
    const id = token ? tokenizer.token_to_id(token) : undefined;
    if (id === undefined || !Number.isInteger(id)) throw new Error(`The tokenizer has no ${what} token`);
    return id;
  };
  const special = {
    cls: idOf("[CLS]", "[CLS]"),
    sep: idOf("[SEP]", "[SEP]"),
    ent: glinerConfig.class_token_index ?? idOf(glinerConfig.ent_token ?? "<<ENT>>", "entity"),
    promptSep: idOf(glinerConfig.sep_token ?? "<<SEP>>", "prompt separator")
  };
  const session = await ort.InferenceSession.create(nerModelFilePath(folder, model.onnx), {
    executionProviders: ["cpu"],
    intraOpNumThreads: settings.intraOpThreads,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
    logSeverityLevel: 3
  });
  for (const input of ["input_ids", "attention_mask", "words_mask", "text_lengths", "span_idx", "span_mask"]) {
    if (!session.inputNames.includes(input)) throw new Error(`The ONNX model has no ${input} input; it is not a GLiNER span model`);
  }
  if (!session.outputNames.includes("logits")) throw new Error("The ONNX model has no logits output; it is not a GLiNER span model");
  const makeTensor: MakeTensor = (type, data, dims) => new ort.Tensor(type, data, dims);
  return new GlinerCore({
    session: session as unknown as GlinerSession,
    makeTensor,
    encode: (text) => tokenizer.encode(text, { add_special_tokens: false }).ids,
    special,
    maxWidth: maxWidth!,
    window: model.window
  });
}
