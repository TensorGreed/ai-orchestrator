/**
 * Phase 15.4 — the trigger-path audit.
 *
 * 1. Every place in the API source that loads a workflow (or a saved
 *    version of one) is listed below with what it is for: a production run
 *    through the release resolver, the draft by design, or not a run at all.
 *    The scan reads every non-test `.ts` file under apps/api/src, so a new
 *    route, service or file that loads a workflow fails this test until
 *    someone decides which version it should see.
 * 2. Every `runWorkflowExecution` call, in any file, names its channel.
 * 3. The production routes and loaders are wired to the production loader.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(here, file), "utf8");
const appSource = read("app.ts");

function sourceFiles(dir = here, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name), relative));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes("test-helper") && !entry.name.endsWith(".d.ts")) out.push(relative);
  }
  return out.sort();
}

/** Calls that load a workflow or one of its saved versions. */
const LOAD_CALL =
  /\b(getWorkflow|getWorkflowVersion|listWorkflowConfigsForDestinations|productionWorkflow|resolveRunnableWorkflow|loadProductionWorkflow|versionWorkflow|getRunnableWorkflow|deactivatedProductionWorkflow)\s*(\?\.)?\(|\.(getWorkflow|getWorkflowVersion)\b(?!\s*[:(?])|\bworkflowVersionService\.get\s*(\?\.)?\(/;
/** A method or interface declaration of one of those, not a call. */
const DECLARATION = /^\s*(?:async\s+|private\s+|public\s+)?(?:(?:getWorkflow|getWorkflowVersion|resolveRunnableWorkflow|versionWorkflow)\(\w+:|listWorkflowConfigsForDestinations\(\):)/;

type LoadKind = "production" | "draft" | "not_run";

interface LoadSite {
  file: string;
  /** A fragment of the trimmed source line; "" matches every load in the file (used only for the store and the resolver itself). */
  match: string;
  kind: LoadKind;
  why: string;
  /** How many loads this entry covers (default 1). */
  count?: number;
  /** A `production` entry that reads the draft only as a default its real caller replaces with the production loader. */
  defaultOnly?: boolean;
  /** The whole trimmed line must equal `match`. */
  exact?: boolean;
}

/**
 * Every workflow load in apps/api/src. `production`: production traffic,
 * which must go through the release resolver (`productionWorkflow`,
 * `resolveRunnableWorkflow`, `versionWorkflow`, `getRunnableWorkflow`).
 * `draft`: the editor, a manual or test run, a replay or eval candidate, an
 * access check whose run names its own channel. `not_run`: names, projects,
 * listings, exports, metadata.
 */
const WORKFLOW_LOADS: LoadSite[] = [
  // The store and the resolver themselves.
  { file: "db/database.ts", match: "", kind: "not_run", why: "the SQLite store's own internals (upsert, delete)", count: 2 },
  { file: "db/postgres-store.ts", match: "", kind: "not_run", why: "the Postgres store's own internals (upsert, delete)", count: 2 },
  { file: "services/release-service.ts", match: "", kind: "production", why: "the release resolver, production path claims and its gate, judge and request checks", count: 19 },
  { file: "services/gate-admission-service.ts", match: "", kind: "not_run", why: "gate admission reads only a workflow's name and project (audit, requests, inbox views)", count: 3 },
  { file: "services/data-destination-service.ts", match: "", kind: "not_run", why: "the not-classified-yet list reads the draft and published node configs for their hosts in one query; nothing runs" },

  // app.ts: production traffic.
  { file: "app.ts", match: "const workflow = productionWorkflow(request.params.workflowId);", kind: "production", why: "Slack, GitHub, Stripe, Telegram, Discord app webhooks and chat", count: 6 },
  { file: "app.ts", match: "const workflow = productionWorkflow(input.workflowId);", kind: "production", why: "a schedule firing" },
  { file: "app.ts", match: "schedulerService.setWorkflowLoader?.((workflowId) => productionWorkflow(workflowId));", kind: "production", why: "schedules register from the published version" },
  { file: "app.ts", match: "triggerService.setWorkflowLoader((workflowId) => productionWorkflow(workflowId));", kind: "production", why: "app and polling triggers register from the published version" },
  { file: "app.ts", match: "getRunnableWorkflow: (id, runChannel) => releaseService.resolveRunnableWorkflow(id, runChannel),", kind: "production", why: "sub-workflows called from a production run" },
  { file: "app.ts", match: 'const productionWorkflow = (workflowId: string): Workflow | null => releaseService.resolveRunnableWorkflow(workflowId, "production");', kind: "production", why: "the production loader itself" },
  { file: "app.ts", match: "const wf = productionWorkflow(summary.id);", kind: "production", why: "form trigger and MCP server trigger lookups", count: 2 },
  { file: "app.ts", match: "const workflow = productionWorkflow(payload.workflowId);", kind: "production", why: "queued runs and dead-letter re-runs" },
  { file: "app.ts", match: '(channel === "production" ? productionWorkflow(payload.sourceWorkflowId) : store.getWorkflow(payload.sourceWorkflowId))', kind: "production", why: "the error workflow follows the failing run's channel" },
  { file: "app.ts", match: "const loadForRoute = (id: string) => (isTestRoute ? store.getWorkflow(id) : productionWorkflow(id));", kind: "production", why: "/webhook/ runs the published version, /webhook-test/ the draft" },
  { file: "app.ts", match: 'const workflow = executeChannel.channel === "production" ? productionWorkflow(access.workflow.id) : access.workflow;', kind: "production", why: "/execute and /execute/stream: API-key callers run the published version (or the draft with channel=draft and workflow:write), the editor the draft", count: 2 },
  { file: "app.ts", match: 'const workflow = retryChannel === "production" ? productionWorkflow(sourceExecution.workflowId) : store.getWorkflow(sourceExecution.workflowId);', kind: "production", why: "a retry of a production run runs what production runs now; a draft run's retry runs the draft" },
  { file: "app.ts", match: "const workflow = releaseService.deactivatedProductionWorkflow(summary.id);", kind: "not_run", why: "a deactivated gated workflow's paths, only to answer \"deactivated\" rather than \"not found\"" },
  { file: "app.ts", match: "const entry = workflowVersionService.get(request.params.id, version);", kind: "not_run", why: "reading or diffing a saved version in the history panel", count: 2 },
  { file: "app.ts", match: "load: WorkflowLoader = (id) => store.getWorkflow(id)", kind: "production", why: "webhook path helpers: production routes pass productionWorkflow (checked below)", count: 4, defaultOnly: true },

  // app.ts: the draft by design.
  { file: "app.ts", match: "const workflow = store.getWorkflow(input.workflowId);", kind: "draft", why: "an eval run runs the draft" },
  { file: "app.ts", match: "const current = store.getWorkflow(candidate.workflow.id);", kind: "draft", why: "a replay job's case: the candidate's current project" },
  { file: "app.ts", match: "const workflow = store.getWorkflow(source.workflowId);", kind: "draft", why: "executions replay (cassette) runs the draft" },
  { file: "app.ts", match: "const current = store.getWorkflow(pending.workflowId);", kind: "not_run", why: "an approval resume runs the paused snapshot; only its current project is read" },
  { file: "app.ts", match: "getWorkflow: (id) => store.getWorkflow(id),", kind: "draft", why: "run-access and run-scope dependencies: access checks and draft-run sub-workflows", count: 2 },
  { file: "app.ts", match: "store.getWorkflow(workflow.id)", exact: true, kind: "draft", why: "approval routes: whether a draft can be executed by the user" },
  { file: "app.ts", match: "loadWorkflow: (id) => store.getWorkflow(id) ?? null,", kind: "not_run", why: "approval routes: names and projects of paused runs" },
  { file: "app.ts", match: "const draft = store.getWorkflow(workflowId);", kind: "draft", why: "snapshotting the draft as a gate's baseline version" },

  // app.ts: not a run.
  { file: "app.ts", match: "if (store.getWorkflow(id)) return true;", kind: "not_run", why: "a unique workflow id" },
  { file: "app.ts", match: "workflowProject: (workflowId) => store.getWorkflow(workflowId)?.projectId ?? null,", kind: "not_run", why: "production capture's promote: only the workflow's project, for the auto-created golden set" },
  {
    file: "services/replay-capture-service.ts",
    match: "if (!store.getExecutionHistory(input.executionId) || !store.getWorkflow(ticket.workflowId)) {",
    kind: "not_run",
    why: "production capture's save: only checks the workflow still exists (a capture of a deleted workflow is discarded)"
  },
  { file: "app.ts", match: "const workflow = store.getWorkflow(summary.id);", kind: "not_run", why: "MCP server usages and the tools listing", count: 2 },
  { file: "app.ts", match: "const workflow = store.getWorkflow(item.id);", kind: "not_run", why: "session namespace owners" },
  { file: "app.ts", match: "const existing = store.getWorkflow(workflow.id);", kind: "not_run", why: "save access check" },
  { file: "app.ts", match: "const workflow = context ? store.getWorkflow(context.workflowId) : null;", kind: "not_run", why: "the LLM judge's project" },
  { file: "app.ts", match: "projectId: store.getWorkflow(pending.workflowId)?.projectId ?? request.projectId,", kind: "not_run", why: "audit project" },
  { file: "app.ts", match: "const workflow = store.getWorkflow(request.params.id);", kind: "not_run", why: "project transfer (admin)" },
  { file: "app.ts", match: "projectId: store.getWorkflow(execution.workflowId)?.projectId", kind: "not_run", why: "audit project" },
  { file: "app.ts", match: "const full = store.getWorkflow(w.id);", kind: "not_run", why: "removing a tag" },

  // Other route files and services.
  { file: "mcp-gateway-routes.ts", match: "deps.loadProductionWorkflow ? deps.loadProductionWorkflow(id) : store.getWorkflow(id)", kind: "production", why: "the gateway's tool list and tool calls (the app always passes the production loader)", defaultOnly: true },
  { file: "mcp-gateway-routes.ts", match: "const workflow = productionWorkflow(tool.workflowId);", kind: "production", why: "a gateway tool call runs the published version" },
  { file: "mcp-gateway-routes.ts", match: "const workflow = store.getWorkflow(member.workflowId);", kind: "not_run", why: "admin toolset views and member validation", count: 2 },
  { file: "mcp-gateway-routes.ts", match: "const workflow = store.getWorkflow(summary.id);", kind: "not_run", why: "listing workflows that can be toolset members" },
  { file: "services/mcp-gateway-catalog.ts", match: "const workflow = store.getWorkflow(member.workflowId);", kind: "production", why: "the catalog store is the gateway's production loader (catalogStore)", defaultOnly: true },
  { file: "services/scheduler-service.ts", match: "this.store.getWorkflow(workflowId)", kind: "production", why: "the loader's default; the app sets the production loader", defaultOnly: true },
  { file: "services/trigger-service.ts", match: "this.store.getWorkflow(workflowId)", kind: "production", why: "the loader's default; the app sets the production loader", defaultOnly: true },
  { file: "run-scope.ts", match: 'deps.getRunnableWorkflow(targetId, "production") : deps.getWorkflow(targetId)', kind: "production", why: "sub-workflows: the child's published version in a production run, its draft in a draft run" },
  { file: "run-access.ts", match: "const workflow = deps.getWorkflow(workflowId);", kind: "draft", why: "access checks; any run they feed names its channel (checked below)" },
  { file: "run-access.ts", match: "const workflow = deps.getWorkflow(run.workflowId) ?? null;", kind: "not_run", why: "run access checks" },
  { file: "mcp-testing-routes.ts", match: "store.getWorkflow(usage.workflowId)", kind: "not_run", why: "MCP server usages" },
  { file: "mcp-control-plane-routes.ts", match: "const workflow = store.getWorkflow(summary.id);", kind: "not_run", why: "MCP server usages" },
  { file: "guard-routes.ts", match: "const workflow = store.getWorkflow(binding.scopeId);", kind: "not_run", why: "guard binding project" },
  { file: "guard-routes.ts", match: "store.getWorkflow(event.workflowId)?.name", kind: "not_run", why: "guard event names" },
  { file: "golden-set-file-routes.ts", match: "store.getWorkflow(", kind: "not_run", why: "the exported file names the golden set's workflow (id and name); nothing runs", count: 1 },
  { file: "eval-routes.ts", match: "store.getWorkflow(", kind: "not_run", why: "golden set and run projects, judge and model-override secret scope, the replay job audit's project", count: 5 },
  { file: "services/approval-service.ts", match: "this.store.getWorkflow(record.workflowId)?.projectId", kind: "not_run", why: "a paused run's current project" },
  { file: "services/eval-service.ts", match: "const workflow = this.store.getWorkflow(request.workflowId);", kind: "draft", why: "an eval run runs the draft" },
  { file: "services/replay-service.ts", match: "const current = this.options.store.getWorkflow(workflowId);", kind: "draft", why: "a replay candidate: the draft" },
  { file: "services/replay-service.ts", match: "const saved = this.options.store.getWorkflow(workflowId);", kind: "not_run", why: "an inline candidate (a file) runs in the saved workflow's project and folder; only those are read" },
  { file: "services/replay-service.ts", match: "const current = this.options.store.getWorkflow(recording.workflowId);", kind: "not_run", why: "a baseline rerun's project, folder and name; the rerun itself is the golden run's saved version (the draft-class candidate load) or its captured workflow, in the replay sandbox" },
  { file: "services/replay-service.ts", match: "this.options.store.getWorkflowVersion(workflowId, request.version)", kind: "draft", why: "a replay candidate: the chosen saved version" },
  { file: "services/replay-recording-service.ts", match: "const current = store.getWorkflow(history.workflowId);", kind: "not_run", why: "recording a golden run" },
  { file: "services/guard-simulation-service.ts", match: "const workflow = store.getWorkflow(workflowId);", kind: "not_run", why: "a guard simulation's scope: the workflow's project, bindings and guard nodes; Phase 16: a destination preview's scope too (its replay jobs load their candidate through the replay service)", count: 2 },
  { file: "services/workflow-version-service.ts", match: "this.store.getWorkflowVersion(workflowId, version)", kind: "not_run", why: "reading a saved version" },
  { file: "services/audit-bundle-service.ts", match: "this.options.store.getWorkflowVersion(workflow.id, latest)", kind: "not_run", why: "a run manifest's saved version" },
  { file: "services/audit-bundle-service.ts", match: "store.getWorkflow(history.workflowId)", kind: "not_run", why: "a run manifest's workflow", count: 2 },
  { file: "services/git-sync-service.ts", match: "const wf = this.store.getWorkflow(summary.id);", kind: "not_run", why: "git export" }
];

const matches = (entry: LoadSite, site: { file: string; text: string }) => entry.file === site.file && (entry.exact ? site.text === entry.match : site.text.includes(entry.match));

const RESOLVER = /productionWorkflow\(|resolveRunnableWorkflow\(|versionWorkflow\(|getRunnableWorkflow\(|loadProductionWorkflow/;

describe("every workflow load is classified", () => {
  const sites: Array<{ file: string; line: number; text: string }> = [];
  for (const file of sourceFiles()) {
    read(file)
      .split("\n")
      .forEach((raw, index) => {
        const text = raw.trim();
        if (text.startsWith("*") || text.startsWith("//") || text.startsWith("/*")) return;
        if (!LOAD_CALL.test(text) || DECLARATION.test(raw)) return;
        sites.push({ file, line: index + 1, text });
      });
  }

  it("sees optional calls, bound or passed references and the version service (N9)", () => {
    for (const evasion of ["store.getWorkflow?.(id)", "const load = store.getWorkflow.bind(store);", "items.map(store.getWorkflow)", "workflowVersionService.get(id, 3)", "store.getWorkflowVersion ?.(id, 1)"]) {
      expect(LOAD_CALL.test(evasion), evasion).toBe(true);
    }
    for (const declaration of ["getWorkflow: (id) => store.getWorkflow", "  getWorkflow(id: string): Workflow | null {"]) {
      expect(LOAD_CALL.test(declaration.split("=>")[0]!) && !DECLARATION.test(declaration), declaration).toBe(false);
    }
  });

  it("finds the loads it should (the scan itself works)", () => {
    expect(sites.length).toBeGreaterThan(60);
    expect(sites.some((site) => site.file === "app.ts" && site.text.includes("productionWorkflow(payload.workflowId)"))).toBe(true);
  });

  it("each load matches exactly one entry in WORKFLOW_LOADS", () => {
    const counts = new Map<LoadSite, number>();
    const problems: string[] = [];
    for (const site of sites) {
      const entries = WORKFLOW_LOADS.filter((entry) => matches(entry, site));
      if (entries.length !== 1) {
        problems.push(
          entries.length === 0
            ? `${site.file}:${site.line} loads a workflow and is not classified: \`${site.text}\`. If production traffic reaches it, load through productionWorkflow / resolveRunnableWorkflow (the published version) and add it to WORKFLOW_LOADS as "production"; if it is the editor, a manual run or a replay/eval candidate, add it as "draft"; if it only reads names or projects, add it as "not_run". Say why.`
            : `${site.file}:${site.line} matches ${entries.length} entries in WORKFLOW_LOADS; make their match fragments distinct.`
        );
        continue;
      }
      counts.set(entries[0]!, (counts.get(entries[0]!) ?? 0) + 1);
    }
    for (const entry of WORKFLOW_LOADS) {
      const expected = entry.count ?? 1;
      const found = counts.get(entry) ?? 0;
      if (found !== expected) {
        problems.push(
          `WORKFLOW_LOADS entry for ${entry.file} ("${entry.match || "every load"}") expects ${expected} load${expected === 1 ? "" : "s"} but the source has ${found}: a load was added, moved or removed there. Classify the new one (production through the resolver, draft by design, or not_run) and update the count.`
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("a production load goes through the release resolver (or is a default the app replaces with it)", () => {
    const bypasses = sites.filter((site) => {
      const entry = WORKFLOW_LOADS.find((candidate) => matches(candidate, site));
      return entry?.kind === "production" && entry.match !== "" && !entry.defaultOnly && !RESOLVER.test(site.text);
    });
    expect(bypasses.map((site) => `${site.file}:${site.line} ${site.text}`)).toEqual([]);
  });
});

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
  const calls = sourceFiles().flatMap((file) => callArguments(read(file), "runWorkflowExecution({").map((text) => ({ file, text })));

  it("each runWorkflowExecution call, in any file, passes channel", () => {
    expect(calls.length).toBeGreaterThanOrEqual(20);
    const missing = calls.filter((entry) => !/\bchannel\s*:/.test(entry.text)).map((entry) => `${entry.file}: ${entry.text.slice(0, 160)}`);
    expect(missing).toEqual([]);
  });

  it("the draft runs only where a person runs it on purpose, and every computed channel is a known one", () => {
    const channels = calls.map((entry) => /\bchannel\s*:\s*([^,\n]+)/.exec(entry.text)?.[1]?.trim() ?? "");
    // Eval run, executions replay, manual trigger, replay sandbox.
    expect(channels.filter((value) => value === '"draft"').length).toBe(4);
    const computed = [...new Set(channels.filter((value) => value !== '"draft"' && value !== '"production"'))].sort();
    expect(computed).toEqual(['executeChannel.channel', 'isTestRoute ? "draft" : "production"', 'retryChannel', 'state.releaseChannel === "production" ? "production" : "draft"'].sort());
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

  it("the signed-in compat webhook routes pass the production loader", () => {
    const calls = callArguments(appSource, "selectWebhookWorkflow(").filter((entry) => !entry.startsWith("selectWebhookWorkflow(\n  workflowId"));
    const routeCalls = appSource.split("await selectWebhookWorkflow(").slice(1).map((rest) => rest.slice(0, rest.indexOf(");")));
    expect(routeCalls.length).toBe(2);
    for (const entry of routeCalls) expect(entry).toContain("productionWorkflow");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("the configured webhook route loads the draft only for /webhook-test/", () => {
    const start = appSource.indexOf("const registerConfiguredWebhookRoute");
    const block = appSource.slice(start, appSource.indexOf('registerConfiguredWebhookRoute("/webhook/:path")', start));
    expect(block).toContain("(isTestRoute ? store.getWorkflow(id) : productionWorkflow(id))");
    expect(block.match(/store\.getWorkflow\(/g)?.length).toBe(1);
  });

  it("the queue, the gateway's tool calls and its catalog use the production loader", () => {
    const queue = appSource.slice(appSource.indexOf("queueService.setHandler("), appSource.indexOf("queueService.setHandler(") + 1500);
    expect(queue).toContain("productionWorkflow(");
    expect(appSource).toMatch(/loadProductionWorkflow:\s*productionWorkflow/);
    const gateway = read("mcp-gateway-routes.ts");
    const start = gateway.indexOf("const callWorkflowTool");
    expect(start).toBeGreaterThan(-1);
    const runGateway = gateway.slice(start, start + 600);
    expect(runGateway).toContain("productionWorkflow(tool.workflowId)");
    expect(gateway).toMatch(/const catalogStore = \{\s*getWorkflow: productionWorkflow,/);
  });

  it("schedules and app triggers register from the production loader", () => {
    for (const file of ["services/scheduler-service.ts", "services/trigger-service.ts"]) {
      const source = read(file);
      // The only draft read is the loader's default, for callers that never set one.
      expect(source.match(/store\.getWorkflow\(/g)?.length, file).toBe(1);
      expect(source).toMatch(/private loadWorkflow: \(workflowId: string\) => Workflow \| null = \(workflowId\) => this\.store\.getWorkflow\(workflowId\);/);
    }
  });

  it("a paused run resumes on the channel and version it started on, and sub-workflows inherit the channel", () => {
    expect(appSource).toContain('channel: state.releaseChannel === "production" ? "production" : "draft"');
    expect(appSource).toContain('releaseVersion: typeof state.releaseVersion === "number" ? state.releaseVersion : null');
    expect(read("run-scope.ts")).toMatch(/getRunnableWorkflow/);
  });
});
