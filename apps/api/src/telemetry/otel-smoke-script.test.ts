import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Runs scripts/otel-smoke.mjs: a real API process (tsx, temporary SQLite database) exporting over OTLP/HTTP to the
 * script's own receiver, stopped with SIGTERM. No collector or other outside service is needed. The script checks the
 * span tree, the stored trace id, the decoded OTLP header, the metrics and that no secret value is exported.
 */
const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const script = path.join(repoRoot, "scripts", "otel-smoke.mjs");

// apps/api/.env overrides the environment, so the script refuses to run with one that sets its settings (exit 3).
// It uses its own SQLite database, so the Postgres run of the suite has nothing to add.
const apiEnv = path.join(repoRoot, "apps", "api", ".env");
const skip = fs.existsSync(apiEnv) || Boolean(process.env.TEST_POSTGRES_URL);

interface SmokeResult {
  ok: boolean;
  protocol: string;
  traceExports: number;
  metricExports: number;
  spanNames?: string[];
  metrics?: string[];
  failures: string[];
}

async function smoke(protocol: "http/json" | "http/protobuf"): Promise<SmokeResult> {
  try {
    const { stdout } = await run(process.execPath, [script, "--protocol", protocol, "--json"], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 150_000
    });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as SmokeResult;
  } catch (error) {
    // A failed check exits 1 and still prints its summary line.
    const stdout = (error as { stdout?: string }).stdout ?? "";
    const line = stdout.trim().split("\n").at(-1);
    if (line?.startsWith("{")) return JSON.parse(line) as SmokeResult;
    throw error;
  }
}

describe.skipIf(skip)("OpenTelemetry smoke test (scripts/otel-smoke.mjs)", () => {
  it("exports the run's spans and the metrics over OTLP/HTTP JSON when the API stops", async () => {
    const result = await smoke("http/json");
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.spanNames).toEqual(
      expect.arrayContaining([
        "POST /api/workflows/:id/execute",
        "invoke_workflow OTel smoke agent",
        "l2m.node agent_orchestrator",
        "invoke_agent Agent",
        "chat demo",
        "tools/list"
      ])
    );
    expect(result.metrics).toEqual(expect.arrayContaining(["ao.http.requests.total", "gen_ai.client.operation.duration"]));
  }, 180_000);

  it("exports both signals over OTLP/HTTP protobuf, the default encoding", async () => {
    const result = await smoke("http/protobuf");
    expect(result.failures).toEqual([]);
    expect(result.traceExports).toBeGreaterThan(0);
    expect(result.metricExports).toBeGreaterThan(0);
  }, 180_000);
});
