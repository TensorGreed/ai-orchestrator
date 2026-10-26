/**
 * Phase 13.1 — store contract: store lifecycle, git config, leader leases, variables, usage events and rollups,
 * budgets and budget alerts, notification configs. The same assertions on SQLite and, with TEST_POSTGRES_URL, on
 * Postgres.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function usage(id: string, overrides: Partial<Parameters<Store["writeUsageEvent"]>[0]> = {}): Parameters<Store["writeUsageEvent"]>[0] {
  return {
    id,
    executionId: `exec-${id}`,
    workflowId: "wf-a",
    workflowName: "Workflow A",
    userId: "u1",
    userEmail: "u1@example.com",
    projectId: "p1",
    triggerType: "manual",
    status: "success",
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 10,
    totalTokens: 150,
    costUsd: 0.1,
    llmCallCount: 2,
    durationMs: 1000,
    providers: [{ providerId: "openai", model: "gpt-x", calls: 2 }],
    createdAt: "2026-10-01T10:15:00.000Z",
    ...overrides
  };
}

describeStoreContract("store contract: store lifecycle and schema markers", (ctx) => {
  it("storageLocation names the database and never carries a password", async () => {
    const location = await ctx.store().storageLocation();
    expect(typeof location).toBe("string");
    expect(location.length).toBeGreaterThan(0);
    expect(location).not.toContain("l2m@");
    expect(location).not.toMatch(/:[^/@]*@/);
    expect(await ctx.store().storageLocation()).toBe(location);
  });

  it("getSchemaMarker answers the approval_requests marker and null for an unknown one", async () => {
    const marker = await ctx.store().getSchemaMarker("approval_requests");
    expect(marker).not.toBeNull();
    expect(Number.isFinite(Date.parse(marker!))).toBe(true);
    expect(await ctx.store().getSchemaMarker("no-such-marker")).toBeNull();
  });
});

describeStoreContract("store contract: git config", (ctx) => {
  it("is null until set, applies defaults, upserts, records syncs and deletes once", async () => {
    const store = ctx.store();
    expect(await store.getGitConfig()).toBeNull();
    expect(await store.deleteGitConfig()).toBe(false);
    await store.recordGitSync({ kind: "push" });
    expect(await store.getGitConfig()).toBeNull();

    await store.upsertGitConfig({ repoUrl: "https://git.example/repo.git" });
    const first = await store.getGitConfig();
    expect(first).toEqual({
      id: "default",
      repoUrl: "https://git.example/repo.git",
      defaultBranch: "main",
      authSecretId: null,
      workflowsDir: "workflows",
      variablesFile: "variables.json",
      userName: "ai-orchestrator",
      userEmail: "sync@ai-orchestrator.local",
      enabled: true,
      lastPushAt: null,
      lastPullAt: null,
      lastError: null,
      updatedAt: expect.stringMatching(ISO)
    });

    await store.upsertGitConfig({
      repoUrl: "https://git.example/other.git",
      defaultBranch: "trunk",
      authSecretId: "sec-1",
      workflowsDir: "wf",
      variablesFile: "vars.json",
      userName: "bot",
      userEmail: "bot@example.com",
      enabled: false
    });
    expect(await store.getGitConfig()).toMatchObject({
      repoUrl: "https://git.example/other.git", defaultBranch: "trunk", authSecretId: "sec-1", workflowsDir: "wf",
      variablesFile: "vars.json", userName: "bot", userEmail: "bot@example.com", enabled: false
    });

    await store.recordGitSync({ kind: "push", error: "rejected" });
    let config = await store.getGitConfig();
    expect(config?.lastPushAt).toMatch(ISO);
    expect(config?.lastPullAt).toBeNull();
    expect(config?.lastError).toBe("rejected");
    expect(config?.updatedAt).toBe(config?.lastPushAt);

    await store.recordGitSync({ kind: "pull" });
    config = await store.getGitConfig();
    expect(config?.lastPullAt).toMatch(ISO);
    expect(config?.lastError).toBeNull();

    expect(await store.deleteGitConfig()).toBe(true);
    expect(await store.deleteGitConfig()).toBe(false);
    expect(await store.getGitConfig()).toBeNull();
  });
});

describeStoreContract("store contract: leader leases", (ctx) => {
  it("acquires a free lease, refuses another holder, renews for the holder and keeps acquiredAt", async () => {
    const store = ctx.store();
    expect(await store.getLease("primary")).toBeNull();
    expect(await store.tryAcquireLease({ leaseName: "primary", holderId: "a", ttlMs: 60_000 })).toBe(true);
    const acquired = await store.getLease("primary");
    expect(acquired).toEqual({
      leaseName: "primary",
      holderId: "a",
      expiresAt: expect.stringMatching(ISO),
      acquiredAt: expect.stringMatching(ISO),
      renewedAt: expect.stringMatching(ISO)
    });
    expect(acquired?.renewedAt).toBe(acquired?.acquiredAt);
    expect(await store.tryAcquireLease({ leaseName: "primary", holderId: "b", ttlMs: 60_000 })).toBe(false);
    await tick();
    expect(await store.tryAcquireLease({ leaseName: "primary", holderId: "a", ttlMs: 60_000 })).toBe(true);
    const renewed = await store.getLease("primary");
    expect(renewed?.holderId).toBe("a");
    expect(renewed?.acquiredAt).toBe(acquired?.acquiredAt);
    expect(Date.parse(renewed!.renewedAt)).toBeGreaterThan(Date.parse(acquired!.renewedAt));
  });

  it("an expired lease is taken over with a new acquiredAt", async () => {
    const store = ctx.store();
    await store.tryAcquireLease({ leaseName: "primary", holderId: "dead", ttlMs: 1 });
    const before = await store.getLease("primary");
    await tick();
    expect(await store.tryAcquireLease({ leaseName: "primary", holderId: "new", ttlMs: 60_000 })).toBe(true);
    const after = await store.getLease("primary");
    expect(after?.holderId).toBe("new");
    expect(Date.parse(after!.acquiredAt)).toBeGreaterThan(Date.parse(before!.acquiredAt));
  });

  it("release needs the holder; list is ordered by name", async () => {
    const store = ctx.store();
    await store.tryAcquireLease({ leaseName: "scheduler", holderId: "a", ttlMs: 60_000 });
    await store.tryAcquireLease({ leaseName: "Queue", holderId: "b", ttlMs: 60_000 });
    await store.tryAcquireLease({ leaseName: "alpha", holderId: "c", ttlMs: 60_000 });
    expect((await store.listLeases()).map((l) => l.leaseName)).toEqual(["Queue", "alpha", "scheduler"]);
    expect(await store.releaseLease("scheduler", "b")).toBe(false);
    expect(await store.releaseLease("missing", "a")).toBe(false);
    expect(await store.releaseLease("scheduler", "a")).toBe(true);
    expect(await store.getLease("scheduler")).toBeNull();
    expect(await store.releaseLease("scheduler", "a")).toBe(false);
  });
});

describeStoreContract("store contract: variables", (ctx) => {
  it("upserts, reads, finds by key, lists in order and deletes once", async () => {
    const store = ctx.store();
    expect(await store.getVariable("v1")).toBeNull();
    await store.upsertVariable({ id: "v1", projectId: "p1", key: "b_key", value: "1", createdBy: "alice" });
    await store.upsertVariable({ id: "v2", projectId: "p1", key: "A_KEY", value: "2" });
    await store.upsertVariable({ id: "v3", projectId: "p0", key: "z", value: "3" });
    const v1 = await store.getVariable("v1");
    expect(v1).toEqual({
      id: "v1", projectId: "p1", key: "b_key", value: "1", createdBy: "alice",
      createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO)
    });
    expect((await store.getVariable("v2"))?.createdBy).toBeNull();
    expect((await store.listVariables("p1")).map((v) => v.key)).toEqual(["A_KEY", "b_key"]);
    expect((await store.listVariables()).map((v) => v.id)).toEqual(["v3", "v2", "v1"]);
    expect(await store.listVariables("none")).toEqual([]);
    expect(await store.findVariableByKey("p1", "b_key")).toEqual({ id: "v1", key: "b_key", value: "1" });
    expect(await store.findVariableByKey("p0", "b_key")).toBeNull();

    await tick();
    await store.upsertVariable({ id: "v1", projectId: "p9", key: "b_key2", value: "new", createdBy: "bob" });
    const updated = await store.getVariable("v1");
    expect(updated).toMatchObject({ projectId: "p1", key: "b_key2", value: "new", createdBy: "alice", createdAt: v1?.createdAt });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(v1!.updatedAt));

    expect(await store.deleteVariable("v1")).toBe(true);
    expect(await store.deleteVariable("v1")).toBe(false);
    expect(await store.getVariable("v1")).toBeNull();
  });

  it("a second variable with the same project and key is refused", async () => {
    const store = ctx.store();
    await store.upsertVariable({ id: "v1", projectId: "p1", key: "k", value: "1" });
    await expect(store.upsertVariable({ id: "v2", projectId: "p1", key: "k", value: "2" })).rejects.toThrow();
    expect(await store.getVariable("v2")).toBeNull();
  });
});

describeStoreContract("store contract: usage events and rollups", (ctx) => {
  async function seed(store: Store) {
    await store.writeUsageEvent(usage("e1"));
    await store.writeUsageEvent(usage("e2", { createdAt: "2026-10-01T10:45:00.000Z", costUsd: 0.2, totalTokens: 200, durationMs: 2001 }));
    await store.writeUsageEvent(usage("e3", {
      createdAt: "2026-10-01T23:59:59.000Z", workflowId: "wf-b", workflowName: null, userId: null, userEmail: "anon@example.com",
      projectId: null, costUsd: 1.5, totalTokens: 10,
      providers: [{ providerId: "openai", model: "gpt-x", calls: 1 }, { providerId: "anthropic", model: "c-1", calls: 3 }]
    }));
    await store.writeUsageEvent(usage("e4", { createdAt: "2026-10-02T00:00:00.000Z", costUsd: 0.05, providers: [] }));
    await store.writeUsageEvent(usage("out", { createdAt: "2026-10-05T00:00:00.000Z", costUsd: 100 }));
  }
  const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-03T00:00:00.000Z" };

  it("lists events newest first with every field, filters and caps the limit", async () => {
    const store = ctx.store();
    await seed(store);
    const events = await store.listUsageEvents();
    expect(events.map((e) => e.id)).toEqual(["out", "e4", "e3", "e2", "e1"]);
    expect(events.find((e) => e.id === "e1")).toEqual({
      id: "e1", executionId: "exec-e1", workflowId: "wf-a", workflowName: "Workflow A", userId: "u1",
      userEmail: "u1@example.com", projectId: "p1", triggerType: "manual", status: "success",
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, totalTokens: 150, costUsd: 0.1, llmCallCount: 2,
      durationMs: 1000, providers: [{ providerId: "openai", model: "gpt-x", calls: 2 }], createdAt: "2026-10-01T10:15:00.000Z"
    });
    expect(events.find((e) => e.id === "e3")).toMatchObject({ workflowName: null, userId: null, projectId: null });
    expect((await store.listUsageEvents({ workflowId: "wf-b" })).map((e) => e.id)).toEqual(["e3"]);
    expect((await store.listUsageEvents({ projectId: "p1", limit: 2 })).map((e) => e.id)).toEqual(["out", "e4"]);
    expect((await store.listUsageEvents({ userId: "u1", limit: 10_000 })).length).toBe(4);
  });

  it("an event without createdAt gets the current time", async () => {
    const store = ctx.store();
    const { createdAt: _unused, ...rest } = usage("now");
    await store.writeUsageEvent(rest);
    const [event] = await store.listUsageEvents();
    expect(event.createdAt).toMatch(ISO);
    expect(Math.abs(Date.parse(event.createdAt) - Date.now())).toBeLessThan(60_000);
  });

  it("totals sum the window (from inclusive, to exclusive) and match userKey on id or email", async () => {
    const store = ctx.store();
    await seed(store);
    const totals = await store.queryUsageTotals(window);
    expect(totals).toMatchObject({ executions: 4, inputTokens: 400, outputTokens: 200, cachedInputTokens: 40, totalTokens: 510, llmCallCount: 8 });
    expect(totals.costUsd).toBeCloseTo(1.85, 6);
    expect(totals.avgDurationMs).toBe(Math.round((1000 + 2001 + 1000 + 1000) / 4));
    expect((await store.queryUsageTotals({ from: "2026-10-02T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z" })).executions).toBe(1);
    expect((await store.queryUsageTotals({ ...window, userKey: "anon@example.com" })).executions).toBe(1);
    expect((await store.queryUsageTotals({ ...window, userKey: "u1" })).executions).toBe(3);
    expect((await store.queryUsageTotals({ ...window, workflowId: "wf-a", projectId: "p1", userId: "u1" })).executions).toBe(3);
    expect(await store.queryUsageTotals({ from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" })).toEqual({
      executions: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, costUsd: 0, llmCallCount: 0, avgDurationMs: 0
    });
  });

  it("day and hour buckets are UTC strings in ascending order", async () => {
    const store = ctx.store();
    await seed(store);
    const days = await store.queryUsageRollup({ ...window, groupBy: "day" });
    expect(days.map((d) => [d.bucket, d.executions])).toEqual([["2026-10-01", 3], ["2026-10-02", 1]]);
    expect(days[0]).toMatchObject({ inputTokens: 300, totalTokens: 360, llmCallCount: 6, avgDurationMs: 1334 });
    expect(days[0].costUsd).toBeCloseTo(1.8, 6);
    const hours = await store.queryUsageRollup({ ...window, groupBy: "hour" });
    expect(hours.map((h) => [h.bucket, h.executions])).toEqual([
      ["2026-10-01T10:00:00", 2], ["2026-10-01T23:00:00", 1], ["2026-10-02T00:00:00", 1]
    ]);
    expect((await store.queryUsageRollup({ ...window, groupBy: "hour", limit: 1 })).map((h) => h.bucket)).toEqual(["2026-10-01T10:00:00"]);
  });

  it("workflow, user and project rollups are ordered by cost and name missing keys", async () => {
    const store = ctx.store();
    await seed(store);
    const workflows = await store.queryUsageRollup({ ...window, groupBy: "workflow" });
    expect(workflows.map((w) => [w.bucket, w.workflowId, w.workflowName, w.executions])).toEqual([
      ["wf-b", "wf-b", null, 1], ["wf-a", "wf-a", "Workflow A", 3]
    ]);
    const users = await store.queryUsageRollup({ ...window, groupBy: "user" });
    expect(users.map((u) => [u.bucket, u.userId, u.userEmail])).toEqual([
      ["(anonymous)", null, "anon@example.com"], ["u1", "u1", "u1@example.com"]
    ]);
    const projects = await store.queryUsageRollup({ ...window, groupBy: "project" });
    expect(projects.map((p) => [p.bucket, p.projectId, p.executions])).toEqual([["(none)", null, 1], ["p1", "p1", 3]]);
    expect(projects[1].costUsd).toBeCloseTo(0.35, 6);
    expect((await store.queryUsageRollup({ ...window, groupBy: "workflow", projectId: "p1" })).map((w) => w.bucket)).toEqual(["wf-a"]);
  });

  it("the provider rollup splits each event by call share", async () => {
    const store = ctx.store();
    await seed(store);
    const providers = await store.queryUsageRollup({ ...window, groupBy: "provider" });
    expect(providers.map((p) => [p.bucket, p.providerId, p.model, p.executions, p.llmCallCount])).toEqual([
      ["anthropic / c-1", "anthropic", "c-1", 1, 3],
      ["openai / gpt-x", "openai", "gpt-x", 3, 5]
    ]);
    expect(providers[0].costUsd).toBeCloseTo(1.125, 6);
    expect(providers[1].costUsd).toBeCloseTo(0.1 + 0.2 + 0.375, 6);
    expect(providers[1].totalTokens).toBe(150 + 200 + Math.round(10 * 0.25));
  });
});

describeStoreContract("store contract: budgets and alerts", (ctx) => {
  const budget = (id: string, overrides: Partial<Parameters<Store["createBudget"]>[0]> = {}): Parameters<Store["createBudget"]>[0] => ({
    id, name: `Budget ${id}`, scopeType: "global", period: "month", limitType: "usd", limitValue: 10, action: "warn", ...overrides
  });

  it("creates with defaults, reads back, lists by scope then name and filters", async () => {
    const store = ctx.store();
    expect(await store.getBudget("b1")).toBeNull();
    await store.createBudget(budget("b1", { name: "Zeta", scopeType: "workflow", scopeId: "wf-1" }));
    await store.createBudget(budget("b2", { name: "alpha", scopeType: "workflow", scopeId: "wf-2", enabled: false, warnThresholdPct: 0.5 }));
    await store.createBudget(budget("b3", { name: "Global", limitValue: 1.25, action: "block", notifyChannel: "https://hooks.example/x", createdBy: "admin" }));
    await store.createBudget(budget("b4", { name: "Empty scope", scopeType: "project", scopeId: "" }));
    expect(await store.getBudget("b3")).toEqual({
      id: "b3", name: "Global", scopeType: "global", scopeId: null, period: "month", limitType: "usd", limitValue: 1.25,
      warnThresholdPct: 0.8, action: "block", notifyChannel: "https://hooks.example/x", enabled: true, createdBy: "admin",
      createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO)
    });
    expect((await store.getBudget("b2"))).toMatchObject({ enabled: false, warnThresholdPct: 0.5, scopeId: "wf-2", notifyChannel: null, createdBy: null });
    expect((await store.listBudgets()).map((b) => b.id)).toEqual(["b3", "b4", "b1", "b2"]);
    expect((await store.listBudgets({ enabledOnly: true })).map((b) => b.id)).toEqual(["b3", "b4", "b1"]);
    expect((await store.listBudgets({ scopeType: "workflow", scopeId: "wf-2" })).map((b) => b.id)).toEqual(["b2"]);
    expect((await store.listBudgets({ scopeId: "" })).map((b) => b.id)).toEqual(["b3", "b4"]);
    await expect(store.createBudget(budget("b1"))).rejects.toThrow();
  });

  it("updates named fields only, answers true for any non-empty patch, false for an empty one", async () => {
    const store = ctx.store();
    await store.createBudget(budget("b1", { notifyChannel: "chan" }));
    const before = await store.getBudget("b1");
    expect(await store.updateBudget("b1", {})).toBe(false);
    await tick();
    expect(await store.updateBudget("b1", { name: "Renamed", limitValue: 20, warnThresholdPct: 0.9, action: "block", notifyChannel: null, enabled: false })).toBe(true);
    const after = await store.getBudget("b1");
    expect(after).toMatchObject({ name: "Renamed", limitValue: 20, warnThresholdPct: 0.9, action: "block", notifyChannel: null, enabled: false, createdAt: before?.createdAt });
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));
    expect(await store.updateBudget("missing", { name: "x" })).toBe(true);
  });

  it("records alerts, answers the latest per window and severity, lists newest first, and deletes with the budget", async () => {
    const store = ctx.store();
    await store.createBudget(budget("b1"));
    await store.createBudget(budget("b2"));
    expect(await store.getLatestBudgetAlert("b1", "2026-10-01T00:00:00.000Z", "warn")).toBeNull();
    await store.recordBudgetAlert({ id: "a1", budgetId: "b1", periodStart: "2026-10-01T00:00:00.000Z", severity: "warn", usageValue: 8.5, limitValue: 10, workflowId: "wf", executionId: "ex", message: "80%" });
    await tick();
    await store.recordBudgetAlert({ id: "a2", budgetId: "b1", periodStart: "2026-10-01T00:00:00.000Z", severity: "block", usageValue: 10.5, limitValue: 10 });
    await tick();
    await store.recordBudgetAlert({ id: "a3", budgetId: "b2", periodStart: "2026-09-01T00:00:00.000Z", severity: "warn", usageValue: 9, limitValue: 10 });
    expect(await store.getLatestBudgetAlert("b1", "2026-10-01T00:00:00.000Z", "warn")).toEqual({ id: "a1", firedAt: expect.stringMatching(ISO) });
    expect((await store.getLatestBudgetAlert("b1", "2026-10-01T00:00:00.000Z", "block"))?.id).toBe("a2");
    expect(await store.getLatestBudgetAlert("b1", "2026-11-01T00:00:00.000Z", "warn")).toBeNull();
    const all = await store.listBudgetAlerts();
    expect(all.map((a) => a.id)).toEqual(["a3", "a2", "a1"]);
    expect(all[2]).toEqual({
      id: "a1", budgetId: "b1", periodStart: "2026-10-01T00:00:00.000Z", severity: "warn", usageValue: 8.5, limitValue: 10,
      workflowId: "wf", executionId: "ex", message: "80%", firedAt: expect.stringMatching(ISO)
    });
    expect(all[1]).toMatchObject({ workflowId: null, executionId: null, message: null });
    expect((await store.listBudgetAlerts({ budgetId: "b1", limit: 1 })).map((a) => a.id)).toEqual(["a2"]);

    expect(await store.deleteBudget("b1")).toBe(true);
    expect(await store.getBudget("b1")).toBeNull();
    expect((await store.listBudgetAlerts()).map((a) => a.id)).toEqual(["a3"]);
    expect(await store.deleteBudget("b1")).toBe(true);
  });
});

describeStoreContract("store contract: notification configs", (ctx) => {
  it("upserts, lists by creation, keeps createdAt on update and deletes once", async () => {
    const store = ctx.store();
    expect(await store.listNotificationConfigs()).toEqual([]);
    await store.upsertNotificationConfig({ id: "n1", channel: "slack", enabled: true, config: { url: "https://x" }, events: ["execution.failure"] });
    await tick();
    await store.upsertNotificationConfig({ id: "n2", channel: "email", enabled: false, config: {}, events: ["execution.success", "execution.failure"] });
    const listed = await store.listNotificationConfigs();
    expect(listed.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(listed[0]).toEqual({
      id: "n1", channel: "slack", enabled: true, config: { url: "https://x" }, events: ["execution.failure"],
      createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO)
    });
    expect(listed[1].enabled).toBe(false);
    await tick();
    await store.upsertNotificationConfig({ id: "n1", channel: "teams", enabled: false, config: { url: "https://y" }, events: [] });
    const updated = (await store.listNotificationConfigs()).find((n) => n.id === "n1");
    expect(updated).toMatchObject({ channel: "teams", enabled: false, config: { url: "https://y" }, events: [], createdAt: listed[0].createdAt });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(listed[0].updatedAt));
    expect(await store.deleteNotificationConfig("n1")).toBe(true);
    expect(await store.deleteNotificationConfig("n1")).toBe(false);
    expect((await store.listNotificationConfigs()).map((n) => n.id)).toEqual(["n2"]);
  });
});
