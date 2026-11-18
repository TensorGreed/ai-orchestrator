// A stand-in model worker for the pool tests: it speaks the pool's messages without loading a model.
// Texts: "crash" exits the thread, "slow" waits until cancelled, "fail" fails, anything else returns one span.
import { parentPort, workerData } from "node:worker_threads";

if (workerData.model.id === "example/load-fails") {
  parentPort.postMessage({ type: "load_failed", message: "fake load failure" });
  process.exit(1);
}
const cancelled = new Set();
parentPort.on("message", (message) => {
  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }
  const { id, job } = message;
  if (job.text === "crash") process.exit(3);
  if (job.text === "fail") {
    parentPort.postMessage({ type: "failed", id, message: "the model run failed" });
    return;
  }
  if (job.text === "slow") {
    const timer = setInterval(() => {
      if (cancelled.has(id)) {
        clearInterval(timer);
        parentPort.postMessage({ type: "cancelled", id });
      }
    }, 5);
    return;
  }
  parentPort.postMessage({ type: "result", id, spans: [{ start: 0, end: Math.min(4, job.text.length), prompt: 0, score: 0.9 }] });
});
parentPort.postMessage({ type: "ready" });
