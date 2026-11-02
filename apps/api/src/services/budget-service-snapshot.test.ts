/**
 * 12.6 — BudgetService's in-memory snapshot: checks read the store only when a block budget matches, a local edit
 * applies at once after refresh(), and the service fails closed when the budgets were never read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { BudgetExceededError, BudgetService, BudgetUnavailableError, type BudgetCheckContext } from "./budget-service.js";

const stores: Array<{ store: Store; dir: string }> = [];

async function freshStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-budget-snap-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  stores.push({ store, dir });
  return store;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { store, dir } of stores.splice(0)) {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const gatewayCall = (clientId: string, toolsetProjectId: string | null = null): BudgetCheckContext => ({
  workflowId: null,
  projectId: null,
  userEmail: null,
  userId: "mcp-client:Agent",
  client: { id: clientId, name: "Agent" },
  toolsetProjectId
});

async function seedUsage(store: Store, input: { tokens: number; clientId?: string; toolsetId?: string; projectId?: string }) {
  await store.writeUsageEvent({
    id: `u_${Math.random().toString(36).slice(2)}`,
    executionId: `e_${Math.random().toString(36).slice(2)}`,
    workflowId: "wf",
    workflowName: "wf",
    userId: null,
    userEmail: null,
    projectId: input.projectId ?? "default",
    triggerType: "mcp_gateway",
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.toolsetId ? { toolsetId: input.toolsetId } : {}),
    status: "success",
    inputTokens: input.tokens,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: input.tokens,
    costUsd: 0,
    llmCallCount: 1,
    durationMs: 1,
    providers: []
  });
}

describe("BudgetService snapshot", () => {
  it("reads nothing per check when no block budget matches, and only the matching budget's usage when one does", async () => {
    const store = await freshStore();
    const service = new BudgetService(store, { refreshMs: 0 });
    await service.start();
    const list = vi.spyOn(store, "listBudgets");
    const usage = vi.spyOn(store, "queryBudgetUsage");
    for (let index = 0; index < 5; index += 1) expect(await service.checkBlock(gatewayCall("c1"))).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
    await store.createBudget({ id: "b-warn", name: "Warn", scopeType: "mcp_client", scopeId: "c1", period: "day", limitType: "tokens", limitValue: 1, action: "warn" });
    await store.createBudget({ id: "b-other", name: "Other", scopeType: "mcp_client", scopeId: "c2", period: "day", limitType: "tokens", limitValue: 1, action: "block" });
    await service.refresh();
    expect(await service.checkBlock(gatewayCall("c1"))).toBeNull();
    // A warn budget and another client's budget are never read on the hot path.
    expect(usage).not.toHaveBeenCalled();
    await store.createBudget({ id: "b-own", name: "Own", scopeType: "mcp_client", scopeId: "c1", period: "day", limitType: "tokens", limitValue: 10, action: "block" });
    // Not refreshed yet: the snapshot does not have it.
    expect(await service.checkBlock(gatewayCall("c1"))).toBeNull();
    await service.refresh();
    await seedUsage(store, { tokens: 10, clientId: "c1" });
    const blocked = await service.checkBlock(gatewayCall("c1"));
    expect(blocked).toBeInstanceOf(BudgetExceededError);
    expect(blocked).toMatchObject({ current: 10, limit: 10, message: 'Budget "Own" exceeded for the current day.' });
    expect(usage).toHaveBeenCalledTimes(1);
    await expect(service.assertNotBlocked(gatewayCall("c1"))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await service.checkBlock(gatewayCall("c2"))).toBeNull();
    service.stop();
  });

  it("matches a project budget through the toolset's project", async () => {
    const store = await freshStore();
    await store.createBudget({ id: "b-proj", name: "Project", scopeType: "project", scopeId: "proj-gw", period: "week", limitType: "tokens", limitValue: 5, action: "block" });
    const service = new BudgetService(store, { refreshMs: 0 });
    await seedUsage(store, { tokens: 6, projectId: "proj-gw" });
    expect(await service.checkBlock(gatewayCall("c1", "proj-gw"))).toBeInstanceOf(BudgetExceededError);
    expect(await service.checkBlock(gatewayCall("c1", "elsewhere"))).toBeNull();
    expect(await service.checkBlock({ ...gatewayCall("c1"), projectId: "proj-gw" })).toBeInstanceOf(BudgetExceededError);
  });

  it("fails closed when the budgets were never read, and keeps the last copy when a re-read fails", async () => {
    const store = await freshStore();
    const service = new BudgetService(store, { refreshMs: 0 });
    const list = vi.spyOn(store, "listBudgets").mockRejectedValueOnce(new Error("db down"));
    await expect(service.checkBlock(gatewayCall("c1"))).rejects.toBeInstanceOf(BudgetUnavailableError);
    expect(await service.checkBlock(gatewayCall("c1"))).toBeNull();
    list.mockRejectedValueOnce(new Error("db down again"));
    await expect(service.refresh()).rejects.toThrow("db down again");
    expect(await service.checkBlock(gatewayCall("c1"))).toBeNull();
  });

  it("re-reads the budgets in the background, so another instance's edit applies", async () => {
    const store = await freshStore();
    const service = new BudgetService(store, { refreshMs: 50 });
    await service.start();
    expect(await service.checkBlock(gatewayCall("c1"))).toBeNull();
    await store.createBudget({ id: "b-own", name: "Own", scopeType: "mcp_client", scopeId: "c1", period: "day", limitType: "tokens", limitValue: 1, action: "block" });
    await seedUsage(store, { tokens: 2, clientId: "c1" });
    const deadline = Date.now() + 10_000;
    let blocked = await service.checkBlock(gatewayCall("c1"));
    while (!blocked && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      blocked = await service.checkBlock(gatewayCall("c1"));
    }
    expect(blocked).toBeInstanceOf(BudgetExceededError);
    service.stop();
  });
});
