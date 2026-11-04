/**
 * The execute route's budget refusal (HTTP 402): every caller allowed to run the workflow learns which budget refused
 * it and when its period started; only admins also get the amounts (`currentUsage`, `limit`), as in the shared 402
 * handler.
 */
import { afterEach, describe, expect, it } from "vitest";
import { callAs, closeReleaseTestContext, createReleaseTestContext, hookWorkflow, loginAs, type ReleaseTestContext } from "./test-support/release.test-helper.js";

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
