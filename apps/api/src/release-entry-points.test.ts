/**
 * Phase 15.4 — the trigger-path audit. Every way a run starts names its
 * release channel, and the production entry points load the workflow
 * through the production loader (the published version) instead of the
 * draft. A new entry point added without a channel fails this test.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(here, file), "utf8");
const appSource = read("app.ts");

/** The argument object of every call starting at `marker`, with its braces balanced. */
function callArguments(source: string, marker: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start < 0) return out;
    let depth = 0;
    let end = start + marker.length - 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(start, end + 1));
    from = end + 1;
  }
}

/** The handler text of a route: from its path string to the end of its registration. */
function routeBlock(source: string, routePath: string): string {
  const start = source.indexOf(`"${routePath}"`);
  expect(start, `route ${routePath} not found in app.ts`).toBeGreaterThan(-1);
  const rest = source.slice(start + routePath.length + 2);
  // The handler ends at the first line back at the route's own indent.
  const next = rest.search(/\n {2}[^ ]/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("every run names its release channel", () => {
  it("each runWorkflowExecution call in app.ts passes channel", () => {
    const calls = callArguments(appSource, "runWorkflowExecution({");
    expect(calls.length).toBeGreaterThanOrEqual(20);
    const missing = calls.filter((entry) => !/\bchannel\s*:/.test(entry)).map((entry) => entry.slice(0, 160));
    expect(missing).toEqual([]);
  });

  it("the draft runs only where a person runs it on purpose", () => {
    const drafts = callArguments(appSource, "runWorkflowExecution({").filter((entry) => /channel:\s*"draft"/.test(entry));
    // Eval run, /execute, /execute/stream, retry, executions replay, manual trigger, replay sandbox.
    expect(drafts.length).toBe(7);
  });
});

describe("production entry points load the published version", () => {
  const productionRoutes = [
    "/api/webhooks/execute",
    "/api/webhooks/execute/stream",
    "/api/webhooks/slack/:workflowId",
    "/api/webhooks/github/:workflowId",
    "/api/webhooks/stripe/:workflowId",
    "/api/webhooks/telegram/:workflowId",
    "/api/webhooks/discord/:workflowId",
    "/api/chat/:workflowId",
    "/api/forms/:path"
  ];

  it.each(productionRoutes)("%s never loads the draft", (routePath) => {
    const block = routeBlock(appSource, routePath);
    expect(block).toMatch(/runWorkflowExecution\(|productionWorkflow\(|selectWebhookWorkflow\(|findFormWorkflow\(/);
    expect(block).not.toMatch(/store\.getWorkflow\(/);
  });

  it("the configured webhook route loads the draft only for /webhook-test/", () => {
    const start = appSource.indexOf("const registerConfiguredWebhookRoute");
    const block = appSource.slice(start, appSource.indexOf('registerConfiguredWebhookRoute("/webhook/:path")', start));
    expect(block).toContain('(isTestRoute ? store.getWorkflow(id) : productionWorkflow(id))');
    expect(block.match(/store\.getWorkflow\(/g)?.length).toBe(1);
  });

  it("form, MCP server trigger lookups, the queue and the gateway use the production loader", () => {
    for (const helper of ["const findFormWorkflow", "const findMcpServerWorkflow"]) {
      const start = appSource.indexOf(helper);
      expect(start, helper).toBeGreaterThan(-1);
      expect(appSource.slice(start, start + 400)).toContain("productionWorkflow(summary.id)");
    }
    const queue = appSource.slice(appSource.indexOf("queueService.setHandler("), appSource.indexOf("queueService.setHandler(") + 1500);
    expect(queue).toContain("productionWorkflow(");
    expect(appSource).toMatch(/loadProductionWorkflow:\s*productionWorkflow/);
  });

  it("schedules and app triggers register from the production loader", () => {
    expect(appSource).toContain("schedulerService.setWorkflowLoader?.((workflowId) => productionWorkflow(workflowId))");
    expect(appSource).toContain("triggerService.setWorkflowLoader((workflowId) => productionWorkflow(workflowId))");
    for (const file of ["services/scheduler-service.ts", "services/trigger-service.ts"]) {
      const source = read(file);
      // The only draft read is the loader's default, for callers that never set one.
      expect(source.match(/store\.getWorkflow\(/g)?.length, file).toBe(1);
      expect(source).toMatch(/private loadWorkflow: \(workflowId: string\) => Workflow \| null = \(workflowId\) => this\.store\.getWorkflow\(workflowId\);/);
    }
  });

  it("a paused run resumes on the channel it started on, and sub-workflows inherit it", () => {
    expect(appSource).toContain('channel: state.releaseChannel === "production" ? "production" : "draft"');
    const scope = read("run-scope.ts");
    expect(scope).toMatch(/getRunnableWorkflow/);
  });
});
