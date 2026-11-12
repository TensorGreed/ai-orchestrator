import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..", "..");
const probe = path.join(apiRoot, "src", "test-support", "telemetry-module-probe.mjs");

/** Builds and exercises a whole API in a fresh process and returns the OpenTelemetry modules it loaded. */
async function loadedOtelModules(env: Record<string, string>): Promise<{ resolved: number; otelModules: string[] }> {
  const { stdout } = await run(process.execPath, ["--import", "tsx", probe, JSON.stringify(env)], {
    cwd: apiRoot,
    env: { ...process.env, NODE_ENV: "test" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000
  });
  const line = stdout.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(line) as { resolved: number; otelModules: string[] };
}

describe("off means off", () => {
  it("loads no @opentelemetry module and not the otel package while tracing is unset", async () => {
    const result = await loadedOtelModules({});
    expect(result.resolved).toBeGreaterThan(100);
    expect(result.otelModules).toEqual([]);
  }, 150_000);

  it("loads none with an endpoint set but OTEL_SDK_DISABLED=true", async () => {
    const result = await loadedOtelModules({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9", OTEL_SDK_DISABLED: "true" });
    expect(result.otelModules).toEqual([]);
  }, 150_000);

  it("does load them once tracing is on (the probe sees them)", async () => {
    const result = await loadedOtelModules({ TRACING_ENABLED: "true" });
    expect(result.otelModules.some((url) => url.includes("/packages/otel/"))).toBe(true);
    expect(result.otelModules.some((url) => url.includes("@opentelemetry/sdk-trace"))).toBe(true);
  }, 150_000);
});
