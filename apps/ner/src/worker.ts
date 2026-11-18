import { parentPort, workerData } from "node:worker_threads";
import { loadGlinerEngine } from "./engine.js";
import { GlinerCancelled, type GlinerCore } from "./gliner.js";
import type { NerModel } from "./models/manifest.js";
import type { WorkerReply, WorkerRequest } from "./pool.js";

/**
 * One model worker: loads the (already verified) model, then runs one text at a time for the pool. Errors go back
 * as fixed messages; nothing here logs, so input text never reaches a log.
 */

const port = parentPort;
if (!port) throw new Error("worker.ts runs as a worker thread");

const { folder, model, intraOpThreads } = workerData as { folder: string; model: NerModel; intraOpThreads: number };
const cancelled = new Set<number>();
const running = new Set<number>();
const send = (reply: WorkerReply) => port.postMessage(reply);

let engine: GlinerCore;
try {
  engine = await loadGlinerEngine(folder, model, { intraOpThreads });
} catch (error) {
  send({ type: "load_failed", message: error instanceof Error ? error.message.slice(0, 300) : "the model did not load" });
  process.exit(1);
}

port.on("message", (message: WorkerRequest) => {
  if (message.type === "cancel") {
    // A cancel that arrives after its text finished is ignored, so the set only holds running ids.
    if (running.has(message.id)) cancelled.add(message.id);
    return;
  }
  const { id, job } = message;
  running.add(id);
  engine.recognize(job.text, job.cuts, () => cancelled.has(id)).then(
    (spans) => {
      running.delete(id);
      cancelled.delete(id);
      send({ type: "result", id, spans });
    },
    (error: unknown) => {
      running.delete(id);
      cancelled.delete(id);
      if (error instanceof GlinerCancelled) send({ type: "cancelled", id });
      else send({ type: "failed", id, message: "the model run failed" });
    }
  );
});
send({ type: "ready" });
