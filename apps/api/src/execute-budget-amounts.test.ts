/**
 * The execute route's budget refusal (HTTP 402): every caller allowed to run the workflow learns which budget refused
 * it and when its period started; only admins also get the amounts (`currentUsage`, `limit`), as in the shared 402
 * handler.
 */
import { afterEach, describe, expect, it } from "vitest";
import { callAs, closeReleaseTestContext, createReleaseTestContext, hookWorkflow, loginAs, type ReleaseTestContext } from "./test-support/release.test-helper.js";
import { testSql } from "./test-support/test-sql.js";

const contexts: ReleaseTestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

describe("POST /api/workflows/:id/execute refused by a block budget", () => {
  it("returns the amounts to admins only; other callers get the message", async () => {
    const context = await createReleaseTestContext();
    contexts.push(context);
    const admin = await loginAs(context, "admin");
    const builder = await loginAs(context, "builder");
    await context.store.upsertWorkflow(hookWorkflow("wf-budget", "done"));
    // A zero token cap is already met, so the next run is refused.
    await context.store.createBudget({
      id: "bgt_zero",
      name: "Zero cap",
      scopeType: "workflow",
      scopeId: "wf-budget",
      period: "month",
      limitType: "tokens",
      limitValue: 0,
      action: "block"
    });

    const asBuilder = await callAs(context, "POST", "/api/workflows/wf-budget/execute", builder.cookie, {});
    expect(asBuilder.statusCode, asBuilder.body).toBe(402);
    expect(asBuilder.headers["retry-after"]).toBeDefined();
    const builderBody = asBuilder.json<Record<string, unknown>>();
    expect(builderBody).toMatchObject({ error: "budget_exceeded", budgetId: "bgt_zero", message: 'Budget "Zero cap" exceeded for the current month.' });
    expect(builderBody.periodStart).toEqual(expect.any(String));
    expect(builderBody).not.toHaveProperty("currentUsage");
    expect(builderBody).not.toHaveProperty("limit");

    const asAdmin = await callAs(context, "POST", "/api/workflows/wf-budget/execute", admin.cookie, {});
    expect(asAdmin.statusCode, asAdmin.body).toBe(402);
    expect(asAdmin.json<Record<string, unknown>>()).toMatchObject({ error: "budget_exceeded", budgetId: "bgt_zero", currentUsage: 0, limit: 0 });
  });
});

describe("13.2 — the shared 402 handler reads the caller through the shared auth path (requestIsAdmin)", () => {
  it("an unscoped admin key gets the amounts on a webhook refusal; an admin key limited to a project does not", async () => {
    const context = await createReleaseTestContext();
    contexts.push(context);
    const admin = await loginAs(context, "admin");
    await context.store.upsertWorkflow(hookWorkflow("wf-budget-hook", "done"));
    // Through the route, so this instance's copy of the budgets is refreshed at once.
    const budget = await callAs(context, "POST", "/api/budgets", admin.cookie, { name: "Small cap", scopeType: "global", period: "month", limitType: "tokens", limitValue: 10, action: "block", warnThresholdPct: 0.8 });
    expect(budget.statusCode, budget.body).toBe(200);
    // Spend already over the cap, so the next run is refused.
    await context.store.writeUsageEvent({
      id: "usage_seed", executionId: "exec_seed", workflowId: "wf-elsewhere", workflowName: "Elsewhere", userId: null, userEmail: null, projectId: "default",
      triggerType: "webhook", status: "success", inputTokens: 50, outputTokens: 0, cachedInputTokens: 0, totalTokens: 50, costUsd: 0, llmCallCount: 1, durationMs: 1, providers: []
    });
    const mint = async (body: Record<string, unknown>) => {
      const created = await callAs(context, "POST", "/api/auth/api-keys", admin.cookie, { name: "k", ...body });
      expect(created.statusCode, created.body).toBe(200);
      return created.json<{ key: string }>().key;
    };
    const viaHook = (key: string) =>
      context.app.inject({ method: "POST", url: "/webhook/hook-wf-budget-hook", headers: { authorization: `Bearer ${key}` }, payload: {} });

    const unscoped = await viaHook(await mint({}));
    expect(unscoped.statusCode, unscoped.body).toBe(402);
    expect(unscoped.json<Record<string, unknown>>()).toMatchObject({ currentUsage: 50, limit: 10 });

    const limited = await viaHook(await mint({ projects: ["default"] }));
    expect(limited.statusCode, limited.body).toBe(402);
    expect(limited.json<Record<string, unknown>>()).not.toHaveProperty("limit");
    expect(limited.json<Record<string, unknown>>()).not.toHaveProperty("currentUsage");
  });

  it("a session restricted by MFA_REQUIRED_ROLES is not treated as an admin: no amounts", async () => {
    const context = await createReleaseTestContext({ env: { MFA_REQUIRED_ROLES: "admin" } });
    contexts.push(context);
    const admin = await loginAs(context, "admin");
    const sessionId = admin.cookie.slice(admin.cookie.indexOf("=") + 1);
    // Unrestricted for the setup (as if MFA had been passed), restricted again afterwards.
    await testSql(context.store).run(`UPDATE sessions SET mfa_verified_at = ? WHERE id = ?`, new Date().toISOString(), sessionId);
    await context.store.upsertWorkflow(hookWorkflow("wf-budget-gate", "done"));
    const budget = await callAs(context, "POST", "/api/budgets", admin.cookie, { name: "Small cap", scopeType: "global", period: "month", limitType: "tokens", limitValue: 10, action: "block", warnThresholdPct: 0.8 });
    expect(budget.statusCode, budget.body).toBe(200);
    await context.store.writeUsageEvent({
      id: "usage_seed_gate", executionId: "exec_seed_gate", workflowId: "wf-elsewhere", workflowName: "Elsewhere", userId: null, userEmail: null, projectId: "default",
      triggerType: "webhook", status: "success", inputTokens: 50, outputTokens: 0, cachedInputTokens: 0, totalTokens: 50, costUsd: 0, llmCallCount: 1, durationMs: 1, providers: []
    });
    const viaHook = () => context.app.inject({ method: "POST", url: "/webhook/hook-wf-budget-gate", headers: { cookie: admin.cookie }, payload: {} });
    const verified = await viaHook();
    expect(verified.statusCode, verified.body).toBe(402);
    expect(verified.json<Record<string, unknown>>()).toMatchObject({ currentUsage: 50, limit: 10 });

    await testSql(context.store).run(`UPDATE sessions SET mfa_verified_at = NULL WHERE id = ?`, sessionId);
    const restricted = await viaHook();
    expect(restricted.statusCode, restricted.body).toBe(402);
    expect(restricted.json<Record<string, unknown>>()).not.toHaveProperty("limit");
  });
});
