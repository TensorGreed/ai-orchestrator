import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { NerHttpError, type NerEntitiesRequest, type NerEntitiesResponse, type NerHealthResponse, type NerModelInfo } from "./contract.js";
import type { NerConfig } from "./config.js";
import { loadGlinerEngine } from "./engine.js";
import { findNerModel, nerModelFile, nerModelFilePath, nerModelFolder, type NerManifest, type NerModel } from "./models/manifest.js";
import { verifyNerModel } from "./models/verify.js";
import { inlineExecutor, NerPool, NerStoppedError, workerExecutorFactory, type NerExecutorFactory } from "./pool.js";
import { entitiesFromRaw, NER_CALIBRATED_CUT, planPrompts } from "./spans.js";

/**
 * The model's lifecycle and the recognize call behind POST /v1/entities. The service starts without a model; it
 * looks for the model folder now and every NER_MODEL_RETRY_MS until it is there, checks every file against the
 * manifest (size and SHA-256), then starts the worker pool. A folder that does not match is refused and reported
 * in /health, and is checked again only when its files change.
 */

export type NerModelState = "missing" | "checking" | "invalid" | "loading" | "ready" | "failed";

export interface NerLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface NerServiceOptions {
  config: NerConfig;
  manifest: NerManifest;
  logger?: NerLogger;
  /** Replaces the model executors (tests). Default: worker threads, or the calling thread when NER_WORKERS=0. */
  executorFactory?: (folder: string, model: NerModel) => NerExecutorFactory;
}

const quietLogger: NerLogger = { info: () => undefined, warn: () => undefined };

/** The version reported for a model: its revision plus a hash of the settings that change its answers. */
export function nerModelVersion(model: NerModel): string {
  const settings = JSON.stringify({ prompts: model.prompts, window: model.window, addressMaxGap: model.addressMaxGap, cut: NER_CALIBRATED_CUT, decoder: 1 });
  return `${model.revision.slice(0, 12)}-${createHash("sha256").update(settings).digest("hex").slice(0, 8)}`;
}

export class NerService {
  readonly model: NerModel;
  readonly folder: string;
  private state: NerModelState = "missing";
  private message: string | undefined;
  private pool: NerPool | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private failedSignature: string | undefined;
  private inFlight = 0;
  private closed = false;
  private readonly logger: NerLogger;

  constructor(private readonly options: NerServiceOptions) {
    this.model = findNerModel(options.manifest, options.config.modelId);
    this.folder = nerModelFolder(options.config.modelsDir, this.model);
    this.logger = options.logger ?? quietLogger;
  }

  get modelInfo(): NerModelInfo {
    return { id: this.model.id, version: nerModelVersion(this.model), sha256: nerModelFile(this.model, this.model.onnx).sha256 };
  }

  get modelState(): NerModelState {
    return this.state;
  }

  /** Looks for the model now; keeps looking in the background until it is loaded. Never throws. */
  async start(): Promise<void> {
    await this.tryLoad();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.tryLoad();
    }, this.options.config.modelRetryMs);
    this.retryTimer.unref();
  }

  /** Size and modification time of every file: a refused folder is hashed again only after it changes. */
  private async signature(): Promise<string> {
    const parts: string[] = [];
    for (const file of this.model.files) {
      try {
        const info = await stat(nerModelFilePath(this.folder, file.path));
        parts.push(`${file.path}:${info.size}:${info.mtimeMs}`);
      } catch {
        parts.push(`${file.path}:-`);
      }
    }
    return parts.join("|");
  }

  private async tryLoad(): Promise<void> {
    if (this.closed || this.state === "ready" || this.state === "checking" || this.state === "loading") return;
    const sizes = await verifyNerModel(this.folder, this.model, { sizesOnly: true });
    if (sizes.files.every((file) => file.status === "missing")) {
      this.setState("missing", `No model in ${this.folder}. Pull it with: models pull ${this.model.id} --accept-licence`);
      this.scheduleRetry();
      return;
    }
    if (!sizes.ok) {
      const missing = sizes.files.filter((file) => file.status !== "ok").map((file) => file.path);
      this.setState("invalid", `The model folder is incomplete or does not match the manifest (${missing.join(", ")}); run models pull again`);
      this.scheduleRetry();
      return;
    }
    const signature = await this.signature();
    if (signature === this.failedSignature) {
      this.scheduleRetry();
      return;
    }
    this.setState("checking", "Checking the model files against the manifest");
    const check = await verifyNerModel(this.folder, this.model);
    if (!check.ok) {
      this.failedSignature = signature;
      const bad = check.files.filter((file) => file.status !== "ok").map((file) => file.path);
      this.setState("invalid", `Model files do not match the manifest's SHA-256 (${bad.join(", ")}); the model was not loaded. Run models pull again`);
      this.logger.warn(`l2m-ner: ${this.message}`);
      this.scheduleRetry();
      return;
    }
    this.setState("loading", "Loading the model");
    const { config } = this.options;
    const factory =
      this.options.executorFactory?.(this.folder, this.model) ??
      (config.workers === 0
        ? async () => inlineExecutor(await loadGlinerEngine(this.folder, this.model, { intraOpThreads: config.threads }))
        : workerExecutorFactory({ folder: this.folder, model: this.model, intraOpThreads: config.threads }));
    const pool = new NerPool(Math.max(1, config.workers), factory, this.logger);
    try {
      await pool.start();
    } catch (error) {
      this.failedSignature = signature;
      this.setState("failed", `The model did not load: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`);
      this.logger.warn(`l2m-ner: ${this.message}`);
      this.scheduleRetry();
      return;
    }
    if (this.closed) {
      await pool.close();
      return;
    }
    this.pool = pool;
    this.failedSignature = undefined;
    this.setState("ready", undefined);
    this.logger.info(`l2m-ner: model ${this.model.id} (${this.modelInfo.version}) loaded with ${Math.max(1, config.workers)} executor(s)`);
  }

  private setState(state: NerModelState, message: string | undefined): void {
    this.state = state;
    this.message = message;
  }

  health(): NerHealthResponse {
    const ready = this.state === "ready" && this.pool !== undefined && this.pool.liveExecutors > 0;
    const poolError = this.state === "ready" ? this.pool?.error : undefined;
    const ok = this.state !== "invalid" && this.state !== "failed";
    const message = ready ? undefined : poolError ?? this.message;
    return { ok, ready, model: ready ? this.modelInfo : null, ...(message ? { message } : {}) };
  }

  async recognize(request: NerEntitiesRequest, signal: AbortSignal): Promise<NerEntitiesResponse> {
    const pool = this.pool;
    if (this.state !== "ready" || !pool || pool.liveExecutors === 0) {
      throw new NerHttpError(503, "not_ready", this.message ?? "The model is not loaded", { "retry-after": "15" });
    }
    if (!this.model.languages.includes(request.language)) {
      throw new NerHttpError(400, "unsupported_language", `language must be one of: ${this.model.languages.join(", ")}`);
    }
    const { config } = this.options;
    let total = 0;
    for (let index = 0; index < request.texts.length; index += 1) {
      const length = request.texts[index]!.length;
      if (length > config.maxTextChars) throw new NerHttpError(413, "too_large", `texts.${index} is longer than ${config.maxTextChars} characters`);
      total += length;
    }
    if (total > config.maxRequestChars) throw new NerHttpError(413, "too_large", `the texts are longer than ${config.maxRequestChars} characters in total`);
    if (this.inFlight >= config.maxQueue) throw new NerHttpError(429, "busy", "Too many requests in progress; try again shortly", { "retry-after": "1" });
    this.inFlight += 1;
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const plan = planPrompts(this.model, request.labels, request.threshold ?? NER_CALIBRATED_CUT);
      const raw = await Promise.all(
        request.texts.map((text) => (text.trim().length === 0 ? Promise.resolve([]) : pool.run({ text, cuts: plan.cuts }, stop.signal)))
      ).catch((error: unknown) => {
        stop.abort();
        throw error;
      });
      return {
        results: request.texts.map((text, index) => ({ entities: entitiesFromRaw(text, raw[index]!, plan, this.model.addressMaxGap) })),
        model: this.modelInfo
      };
    } catch (error) {
      if (error instanceof NerHttpError) throw error;
      if (error instanceof NerStoppedError || signal.aborted) throw new NerHttpError(503, "timeout", "The request was stopped before the model finished");
      throw new NerHttpError(503, "failed", "The model run failed");
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.inFlight -= 1;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.pool?.close();
  }
}
