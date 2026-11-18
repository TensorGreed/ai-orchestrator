import { loadNerConfig } from "./config.js";
import { disableRuntimeTelemetry } from "./engine.js";
import { bundledManifestPath, loadNerManifest } from "./models/manifest.js";
import { runNerModelsCommand } from "./models/cli.js";
import { createNerServer } from "./server.js";
import { NerService } from "./service.js";

/**
 * l2m-ner entry point.
 *
 *   serve                 the HTTP service (the default)
 *   models list|pull|verify …   manage the models folder (see `models --help`)
 */

const log = (level: "info" | "warn" | "error", entry: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, ...entry })}\n`);
};

async function serve(): Promise<number> {
  const config = loadNerConfig();
  const manifest = loadNerManifest(config.manifestFile ?? bundledManifestPath());
  const service = new NerService({
    config,
    manifest,
    logger: { info: (msg) => log("info", { msg }), warn: (msg) => log("warn", { msg }) }
  });
  const server = createNerServer(service, config, { info: (entry) => log("info", entry) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  log("info", {
    msg: `l2m-ner listening on ${config.host}:${config.port}`,
    model: service.model.id,
    modelsDir: config.modelsDir,
    workers: config.workers,
    threads: config.threads,
    token: config.token ? "required" : "not set"
  });
  if (!config.token && !["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    log("warn", { msg: "No token is set (NER_TOKEN or NER_TOKEN_FILE): anyone who can reach this address can send text to the model. Keep the port private or set a token." });
  }
  void service.start().catch((error: unknown) => log("error", { msg: `model start failed: ${error instanceof Error ? error.message : "unknown"}` }));
  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log("info", { msg: `${signal}: shutting down` });
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 10_000).unref();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });
  await service.close();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  // Before any worker starts: worker threads inherit the process environment the native library reads.
  disableRuntimeTelemetry();
  const [command = "serve", ...rest] = argv;
  if (command === "serve") return serve();
  if (command === "models") return runNerModelsCommand(rest, { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env });
  process.stderr.write("Usage: l2m-ner [serve] | l2m-ner models list|pull|verify …\n");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log("error", { msg: error instanceof Error ? error.message : "l2m-ner failed" });
    process.exitCode = 1;
  }
);
