// Test fixture for pdf.test.ts: started exactly like the PDF reader child (same Node options, its own script in
// place of pdf-child.mjs), it tries what a document must never make the reader do and reports each outcome.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { Worker } from "node:worker_threads";

const attempt = (run) => {
  try {
    run();
    return "allowed";
  } catch (error) {
    return error?.code === "ERR_ACCESS_DENIED" ? "denied" : `error:${error?.name ?? "?"}`;
  }
};

process.once("message", async ({ secretFile, writeFile, port }) => {
  const assetRoot = process.argv[2];
  const network = await new Promise((resolve) => {
    try {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve("allowed");
      });
      socket.once("error", (error) => resolve(error?.code === "ERR_ACCESS_DENIED" ? "denied" : `error:${error?.code}`));
    } catch (error) {
      resolve(error?.code === "ERR_ACCESS_DENIED" ? "denied" : `error:${error?.code}`);
    }
  });
  process.send({
    readOutside: attempt(() => readFileSync(secretFile, "utf8")),
    readEnviron: attempt(() => readFileSync("/proc/self/environ")),
    readPackage: attempt(() => readFileSync(`${assetRoot}package.json`, "utf8")),
    write: attempt(() => writeFileSync(writeFile, "x")),
    childProcess: attempt(() => spawnSync("true")),
    worker: attempt(() => new Worker("1", { eval: true })),
    evalCode: (() => {
      try {
        return String(eval("1 + 1"));
      } catch (error) {
        return error instanceof EvalError ? "denied" : `error:${error?.name}`;
      }
    })(),
    envKeys: Object.keys(process.env).length,
    network
  });
});
process.send({ ready: true });
