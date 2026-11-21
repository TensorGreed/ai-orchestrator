/**
 * The CI workflow's contract with branch protection: main requires the checks "Lint Test Build", "API on Postgres"
 * and "Web E2E". The suites run as sharded, parallel jobs; these tests keep the three names, and keep each of them a
 * job that runs whatever happened before it and passes only when every part it stands for passed.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "../../..");

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  strategy?: { matrix?: { shard?: number[] } };
  steps?: Array<{ name?: string; run?: string; uses?: string; if?: string }>;
}

const workflow = parse(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const jobs = workflow.jobs;
const needsOf = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);
const jobNamed = (name: string) => {
  const found = Object.entries(jobs).filter(([, job]) => job.name === name);
  expect(found, `exactly one job named "${name}"`).toHaveLength(1);
  return found[0]!;
};
const script = (job: Job) => (job.steps ?? []).map((step) => step.run ?? "").join("\n");

describe("CI workflow required checks", () => {
  it.each(["Lint Test Build", "API on Postgres", "Web E2E"])("has one job named %s that always runs", (name) => {
    const [, job] = jobNamed(name);
    expect(job.if).toBe("always()");
    expect(job.strategy, "a required check must not be a matrix (its check run name would change)").toBeUndefined();
    expect(script(job)).toContain('[ "$CHANGES" = success ]');
  });

  it("Lint Test Build waits for lint and build, the unit tests and every API unit shard", () => {
    const [, job] = jobNamed("Lint Test Build");
    expect(needsOf(job).sort()).toEqual(["api-unit", "changes", "lint-build", "unit"]);
    const body = script(job);
    for (const result of ["needs.lint-build.result", "needs.unit.result", "needs.api-unit.result"]) {
      expect(JSON.stringify(job.steps)).toContain(result);
    }
    expect(body).toContain('[ "$API_UNIT" = success ]');
    expect(body).toContain('[ "$UNIT" = success ]');
    expect(body).toContain('[ "$LINT_BUILD" = success ]');
  });

  it("API on Postgres waits for every Postgres shard and passes a skip only when the change does not need them", () => {
    const [, job] = jobNamed("API on Postgres");
    expect(needsOf(job).sort()).toEqual(["api-postgres-shard", "changes"]);
    const body = script(job);
    expect(body).toContain('[ "$SHARDS" = success ]');
    expect(body).toMatch(/\[ "\$NEEDED" = false \] && \[ "\$SHARDS" = skipped \]/);
    expect(jobs["api-postgres-shard"]!.if).toBe("needs.changes.outputs.api_postgres != 'false'");
  });

  it("Web E2E waits for both end-to-end suites and passes a skip only when the change does not need them", () => {
    const [, job] = jobNamed("Web E2E");
    expect(needsOf(job).sort()).toEqual(["changes", "e2e-run"]);
    const body = script(job);
    expect(body).toContain('[ "$SUITES" = success ]');
    expect(body).toMatch(/\[ "\$NEEDED" = false \] && \[ "\$SUITES" = skipped \]/);
    const run = jobs["e2e-run"]!;
    expect(run.if).toBe("needs.changes.outputs.web_e2e != 'false'");
    expect(script(run)).toContain("pnpm --filter @ai-orchestrator/web e2e\n");
    expect(script(run)).toContain("pnpm --filter @ai-orchestrator/web e2e:demo");
  });

  it("each required check's step runs even when the run was cancelled", () => {
    for (const name of ["Lint Test Build", "API on Postgres", "Web E2E"]) {
      const [, job] = jobNamed(name);
      expect(job.steps?.every((step) => step.if === "always()"), name).toBe(true);
    }
  });

  it("checks every change-detection output and reads renamed files under their old path", () => {
    const detect = script(jobs.changes!);
    expect(detect).toContain("set -euo pipefail");
    expect(detect).toContain("for key in docs_only api_postgres web_e2e");
    expect(detect).toContain(".previous_filename // empty");
  });

  it("shards the API suites with vitest, reading the shard total from the matrix", () => {
    for (const id of ["api-unit", "api-postgres-shard"]) {
      const job = jobs[id]!;
      const shards = job.strategy?.matrix?.shard ?? [];
      expect(shards.length).toBeGreaterThan(1);
      expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1));
      expect(job.name).toContain("${{ matrix.shard }}/${{ strategy.job-total }}");
      expect(script(job)).toContain('vitest run --passWithNoTests --shard="$SHARD"');
      expect(JSON.stringify(job.steps)).toContain("${{ matrix.shard }}/${{ strategy.job-total }}");
      expect((job.strategy as { "fail-fast"?: boolean })["fail-fast"]).toBe(false);
    }
    expect(JSON.stringify(jobs["api-postgres-shard"]!.steps)).toContain('"TEST_STORE":"postgres"');
  });

  it("runs every other package's unit tests in the unit job", () => {
    expect(script(jobs.unit!)).toContain("pnpm -r --no-sort --if-present --filter '!@ai-orchestrator/api' test");
  });

  it("keeps lint, the script tests, both benchmarks, build and the docs build", () => {
    const body = script(jobs["lint-build"]!);
    for (const command of [
      "pnpm lint",
      "scripts/release/vuln-gate.test.mjs",
      "scripts/ci/changed-areas.test.mjs",
      "guard benchmark --builtin",
      "guard benchmark --entities",
      "pnpm build",
      "pnpm docs:build"
    ]) {
      expect(body).toContain(command);
    }
  });

  it("no suite job waits for another suite", () => {
    for (const id of ["lint-build", "unit", "api-unit", "api-postgres-shard", "e2e-run", "vscode-extension", "mcp-conformance"]) {
      expect(needsOf(jobs[id]!), id).toEqual(["changes"]);
    }
  });
});
