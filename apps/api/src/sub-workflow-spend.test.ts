/**
 * Model spend of sub-workflows (Execute Workflow): a child runs inside its parent's run, so its spend is the run's.
 * It is recorded in the run's usage (the top-level run's workflow, project, user and client) and counts toward the
 * budgets that run is matched against; a child started while one of those `block` budgets is used up is refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { callAs, closeReleaseTestContext, createReleaseTestContext, loginAs, testNode, type ReleaseTestContext } from "./test-support/release.test-helper.js";

const contexts: ReleaseTestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

/** sub-workflow trigger → echo model → output. */
function modelChild(id: string, projectId = "default"): Workflow {
  return {
    id,
    name: `Child ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      testNode("start", "sub_workflow_trigger"),
      testNode("model", "llm_call", { provider: { providerId: "echo", model: "echo-1" }, userPromptTemplate: "Summarise the order history of a customer in a few words" }),
      testNode("out", "output")
    ],
    edges: [
      { id: "e1", source: "start", target: "model" },
      { id: "e2", source: "model", target: "out" }
    ]
  } as Workflow;
}

/** A trigger, then the given Execute Workflow steps in a row, then an output. */
function chain(id: string, steps: Array<{ id: string; workflowId: string; mode?: "sync" | "async" }>, options: { trigger?: string; projectId?: string } = {}): Workflow {
  const nodes: WorkflowNode[] = [
    testNode("start", options.trigger ?? "manual_trigger"),
    ...steps.map((step) => testNode(step.id, "execute_workflow", { workflowId: step.workflowId, mode: step.mode ?? "sync" })),
    testNode("out", "output")
  ];
  return {
    id,
    name: `Caller ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: options.projectId ?? "default",
    nodes,
    edges: nodes.slice(1).map((entry, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: entry.id }))
  } as Workflow;
}

const monthWindow = () => {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
  };
};

async function setup(): Promise<{ context: ReleaseTestContext; cookie: string }> {
  const context = await createReleaseTestContext();
  contexts.push(context);
  const admin = await loginAs(context, "admin");
  return { context, cookie: admin.cookie };
}

type RunBody = { status: string; nodeResults: Array<{ nodeId: string; status: string; error?: string }> };

async function execute(context: ReleaseTestContext, cookie: string, workflowId: string) {
  return await callAs(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, {});
}

const tokensOf = async (context: ReleaseTestContext, filter: { workflowId?: string; projectId?: string } = {}) =>
  (await context.store.queryBudgetUsage({ ...monthWindow(), ...filter })).totalTokens;

/** The tokens one run of the child spends, measured by running a copy of it on its own. */
async function childTokens(context: ReleaseTestContext, cookie: string): Promise<number> {
  await context.store.upsertWorkflow(modelChild("wf-probe"));
  const response = await execute(context, cookie, "wf-probe");
  expect(response.statusCode, response.body).toBe(200);
  const tokens = await tokensOf(context, { workflowId: "wf-probe" });
  expect(tokens).toBeGreaterThan(0);
  return tokens;
}

/** Through the route, so the budget snapshot sees it at once. */
async function createBudget(context: ReleaseTestContext, cookie: string, budget: Record<string, unknown>): Promise<void> {
  const response = await callAs(context, "POST", "/api/budgets", cookie, { warnThresholdPct: 0.8, ...budget });
  expect(response.statusCode, response.body).toBe(200);
}

/** sub-workflow trigger → a wait → echo model → output: a child that runs for `delayMs`. */
function slowChild(id: string, delayMs: number): Workflow {
  const base = modelChild(id);
  base.nodes.splice(1, 0, testNode("pause", "wait_node", { delayMs }));
  base.edges = [
    { id: "e1", source: "start", target: "pause" },
    { id: "e2", source: "pause", target: "model" },
    { id: "e3", source: "model", target: "out" }
  ];
  return base;
}

/** manual → Loop over `items` → async Execute Workflow, and the loop → output. */
function fanOut(id: string, childId: string): Workflow {
  return {
    id,
    name: `Fan-out ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      testNode("start", "manual_trigger"),
      testNode("loop", "loop_node", { inputKey: "items", itemVariable: "item", maxIterations: 500 }),
      testNode("call", "execute_workflow", { workflowId: childId, mode: "async" }),
      testNode("out", "output")
    ],
    edges: [
      { id: "e1", source: "start", target: "loop" },
      { id: "e2", source: "loop", target: "call" },
      { id: "e3", source: "loop", target: "out" }
    ]
  } as Workflow;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("sub-workflow model spend", { timeout: 20_000 }, () => {
  it("records a synchronous child's spend in the top-level run's usage row", async () => {
    const { context, cookie } = await setup();
    const perRun = await childTokens(context, cookie);
    await context.store.upsertWorkflow(modelChild("wf-child"));
    await context.store.upsertWorkflow(chain("wf-parent", [{ id: "call", workflowId: "wf-child" }]));

    const response = await execute(context, cookie, "wf-parent");
    expect(response.statusCode, response.body).toBe(200);

    expect(await tokensOf(context, { workflowId: "wf-parent" })).toBe(perRun);
    // One row for the run: the child adds no row (and no execution) of its own.
    expect(await context.store.listUsageEvents({ workflowId: "wf-parent" })).toHaveLength(1);
    expect(await context.store.listUsageEvents({ workflowId: "wf-child" })).toHaveLength(0);
  });

  it("records a failing child's spend too", async () => {
    const { context, cookie } = await setup();
    const perRun = await childTokens(context, cookie);
    const failing = modelChild("wf-child");
    // It fails after its model call: it calls a workflow that does not exist.
    failing.nodes.push(testNode("boom", "execute_workflow", { workflowId: "wf-missing" }));
    failing.edges = [
      { id: "e1", source: "start", target: "model" },
      { id: "e2", source: "model", target: "boom" },
      { id: "e3", source: "boom", target: "out" }
    ];
    await context.store.upsertWorkflow(failing);
    await context.store.upsertWorkflow(chain("wf-parent", [{ id: "call", workflowId: "wf-child" }]));

    const response = await execute(context, cookie, "wf-parent");
    expect(response.json<RunBody>().status).toBe("error");
    expect(await tokensOf(context, { workflowId: "wf-parent" })).toBe(perRun);
  });

  it("records the spend of nested children once, in the top-level run", async () => {
    const { context, cookie } = await setup();
    const perRun = await childTokens(context, cookie);
    await context.store.upsertWorkflow(modelChild("wf-leaf"));
    await context.store.upsertWorkflow(chain("wf-middle", [{ id: "call", workflowId: "wf-leaf" }], { trigger: "sub_workflow_trigger" }));
    await context.store.upsertWorkflow(chain("wf-top", [{ id: "call", workflowId: "wf-middle" }]));

    const response = await execute(context, cookie, "wf-top");
    expect(response.statusCode, response.body).toBe(200);

    expect(await tokensOf(context, { workflowId: "wf-top" })).toBe(perRun);
    // Counted once: the deployment's total is the probe's run plus this one.
    expect(await tokensOf(context)).toBe(2 * perRun);
  });

  it("records an asynchronous child's spend for the run that started it", async () => {
    const { context, cookie } = await setup();
    const perRun = await childTokens(context, cookie);
    await context.store.upsertWorkflow(modelChild("wf-child"));
    await context.store.upsertWorkflow(chain("wf-parent", [{ id: "call", workflowId: "wf-child", mode: "async" }]));

    const response = await execute(context, cookie, "wf-parent");
    expect(response.statusCode, response.body).toBe(200);

    await waitFor(async () => (await tokensOf(context, { workflowId: "wf-parent" })) === perRun);
    expect(await tokensOf(context)).toBe(2 * perRun);
  });

  it("keeps the spend of children run before an approval pause, and counts those after the resume once", async () => {
    const { context, cookie } = await setup();
    const perRun = await childTokens(context, cookie);
    await context.store.upsertWorkflow(modelChild("wf-child"));
    const parent = chain("wf-parent", [
      { id: "before", workflowId: "wf-child" },
      { id: "after", workflowId: "wf-child" }
    ]);
    // manual → before → gate → (approved) after → out
    parent.nodes.push(testNode("gate", "approval_gate", { message: "Go on?" }));
    parent.edges = [
      { id: "e1", source: "start", target: "before" },
      { id: "e2", source: "before", target: "gate" },
      { id: "e3", source: "gate", sourceHandle: "approved", target: "after" },
      { id: "e4", source: "after", target: "out" }
    ];
    await context.store.upsertWorkflow(parent);

    const paused = await execute(context, cookie, "wf-parent");
    const { executionId, status } = paused.json<{ executionId: string; status: string }>();
    expect(status, paused.body).toBe("waiting_approval");
    // The run is not recorded until it ends; the child it already ran is.
    expect(await tokensOf(context, { workflowId: "wf-parent" })).toBe(perRun);

    const lead = await loginAs(context, "admin", "lead");
    const approved = await callAs(context, "POST", `/api/approvals/${executionId}/approve`, lead.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    await waitFor(async () => (await tokensOf(context, { workflowId: "wf-parent" })) === 2 * perRun);
    expect(await tokensOf(context)).toBe(3 * perRun);
  });

  it("counts a child in another project toward the top-level run's project", async () => {
    const { context, cookie } = await setup();
    const perRun = await childTokens(context, cookie);
    await context.store.upsertProject({ id: "proj-tools", name: "Tools" });
    await context.store.upsertWorkflow(modelChild("wf-child", "proj-tools"));
    await context.store.upsertWorkflowShare({ workflowId: "wf-child", projectId: "default", accessLevel: "execute" });
    await context.store.upsertWorkflow(chain("wf-parent", [{ id: "call", workflowId: "wf-child" }]));

    const response = await execute(context, cookie, "wf-parent");
    expect(response.json<RunBody>().status).toBe("success");
    // The caller pays: the probe and the parent are in the default project; the child's project counts nothing.
    expect(await tokensOf(context, { projectId: "default" })).toBe(2 * perRun);
    expect(await tokensOf(context, { projectId: "proj-tools" })).toBe(0);
  });

  it("refuses a child started once a block budget of the top-level run is used up, this run's earlier children included", async () => {
    const { context, cookie } = await setup();
    await context.store.upsertWorkflow(modelChild("wf-child"));
    await context.store.upsertWorkflow(
      chain("wf-loop", [
        { id: "first", workflowId: "wf-child" },
        { id: "second", workflowId: "wf-child" }
      ])
    );
    await createBudget(context, cookie, {
      name: "One call",
      scopeType: "workflow",
      scopeId: "wf-loop",
      period: "month",
      limitType: "tokens",
      limitValue: 1,
      action: "block"
    });

    const response = await execute(context, cookie, "wf-loop");
    const body = response.json<RunBody>();
    expect(body.status, response.body).toBe("error");
    expect(body.nodeResults.find((entry) => entry.nodeId === "first")?.status).toBe("success");
    const second = body.nodeResults.find((entry) => entry.nodeId === "second");
    expect(second?.status).toBe("error");
    expect(second?.error).toContain('Budget "One call" exceeded');
    // The run's usage holds the first child's spend.
    expect(await tokensOf(context, { workflowId: "wf-loop" })).toBeGreaterThan(0);
  });

  it("refuses an asynchronous child the same way", async () => {
    const { context, cookie } = await setup();
    await context.store.upsertWorkflow(modelChild("wf-child"));
    await context.store.upsertWorkflow(
      chain("wf-fanout", [
        { id: "first", workflowId: "wf-child" },
        { id: "later", workflowId: "wf-child", mode: "async" }
      ])
    );
    await createBudget(context, cookie, {
      name: "Project cap",
      scopeType: "project",
      scopeId: "default",
      period: "month",
      limitType: "tokens",
      limitValue: 1,
      action: "block"
    });

    const body = (await execute(context, cookie, "wf-fanout")).json<RunBody>();
    const later = body.nodeResults.find((entry) => entry.nodeId === "later");
    expect(later?.status).toBe("error");
    expect(later?.error).toContain('Budget "Project cap" exceeded');
  });

  describe("a fan-out of 500 async children", () => {
    const DELAY_MS = 1_500;
    /** How many of the 500 children ran: their spend, once every started child has ended. */
    async function started(context: ReleaseTestContext, cookie: string, perRun: number): Promise<number> {
      const response = await callAs(context, "POST", "/api/workflows/wf-fanout/execute", cookie, { input: { items: Array.from({ length: 500 }, (_, index) => index) } });
      // With a budget the first refused child fails the loop (and the run); the children already started run on.
      expect([200, 400]).toContain(response.statusCode);
      await sleep(DELAY_MS + 1_500);
      return (await tokensOf(context, { workflowId: "wf-fanout" })) / perRun;
    }

    it("all start when no block budget applies", async () => {
      const { context, cookie } = await setup();
      const perRun = await childTokens(context, cookie);
      await context.store.upsertWorkflow(slowChild("wf-slow", DELAY_MS));
      await context.store.upsertWorkflow(fanOut("wf-fanout", "wf-slow"));
      expect(await started(context, cookie, perRun)).toBe(500);
    });

    it("start only while the running children's reservations fit a small cap", async () => {
      const { context, cookie } = await setup();
      const perRun = await childTokens(context, cookie);
      await context.store.upsertWorkflow(slowChild("wf-slow", DELAY_MS));
      await context.store.upsertWorkflow(fanOut("wf-fanout", "wf-slow"));
      // 5,000 tokens: before any child ends, each running child is reserved at 1,000 tokens, so five start.
      await createBudget(context, cookie, { name: "Small cap", scopeType: "workflow", scopeId: "wf-fanout", period: "month", limitType: "tokens", limitValue: 5_000, action: "block" });
      expect(await started(context, cookie, perRun)).toBe(5);
      // A refusal is audited once per budget and period.
      const audits = (await context.store.listAuditLogs({ eventType: "budget.run_refused", pageSize: 100 })).items;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ resourceId: "wf-fanout", metadata: expect.objectContaining({ triggerType: "sub_workflow", subWorkflowId: "wf-slow" }) });
    });

    it("all start under a block budget that their reservations fit", async () => {
      const { context, cookie } = await setup();
      const perRun = await childTokens(context, cookie);
      await context.store.upsertWorkflow(slowChild("wf-slow", DELAY_MS));
      await context.store.upsertWorkflow(fanOut("wf-fanout", "wf-slow"));
      await createBudget(context, cookie, { name: "Large cap", scopeType: "global", period: "month", limitType: "tokens", limitValue: 1_000_000_000, action: "block" });
      expect(await started(context, cookie, perRun)).toBe(500);
    });
  });

  describe("children started after an approval", () => {
    /** manual → gate → (approved) Execute Workflow → output. */
    function gatedCaller(): Workflow {
      const parent = chain("wf-gated", [{ id: "call", workflowId: "wf-child" }]);
      parent.nodes.push(testNode("gate", "approval_gate", { message: "Go on?" }));
      parent.edges = [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", sourceHandle: "approved", target: "call" },
        { id: "e3", source: "call", target: "out" }
      ];
      return parent;
    }
    /** Uses up a user's budget with a recorded run of another workflow. */
    async function useUp(context: ReleaseTestContext, email: string): Promise<void> {
      await context.store.writeUsageEvent({
        id: `usage_${email}`, executionId: `exec-${email}`, workflowId: "wf-other", userEmail: email, projectId: "default", status: "success",
        inputTokens: 0, outputTokens: 50, cachedInputTokens: 0, totalTokens: 50, costUsd: 0, llmCallCount: 1, durationMs: 1, providers: []
      });
    }
    async function pauseThenApprove(context: ReleaseTestContext, starter: string, approver: string, beforeApprove?: (executionId: string) => Promise<void>) {
      const paused = await execute(context, starter, "wf-gated");
      const { executionId, status } = paused.json<{ executionId: string; status: string }>();
      expect(status, paused.body).toBe("waiting_approval");
      await beforeApprove?.(executionId);
      const approved = await callAs(context, "POST", `/api/approvals/${executionId}/approve`, approver, {});
      return approved.json<RunBody>();
    }

    it("are checked against the budgets of the user who started the run", async () => {
      const { context, cookie } = await setup();
      const lead = await loginAs(context, "admin", "lead");
      await context.store.upsertWorkflow(modelChild("wf-child"));
      await context.store.upsertWorkflow(gatedCaller());
      await createBudget(context, cookie, { name: "Starter cap", scopeType: "user", scopeId: "admin@example.com", period: "month", limitType: "tokens", limitValue: 10, action: "block" });
      // The starter's budget is used up while the run waits.
      const body = await pauseThenApprove(context, cookie, lead.cookie, async () => await useUp(context, "admin@example.com"));
      const call = body.nodeResults.find((entry) => entry.nodeId === "call");
      expect(call?.status).toBe("error");
      expect(call?.error).toContain('Budget "Starter cap" exceeded');
    });

    it("are not refused by the approver's budget", async () => {
      const { context, cookie } = await setup();
      const lead = await loginAs(context, "admin", "lead");
      await context.store.upsertWorkflow(modelChild("wf-child"));
      await context.store.upsertWorkflow(gatedCaller());
      await createBudget(context, cookie, { name: "Approver cap", scopeType: "user", scopeId: lead.email, period: "month", limitType: "tokens", limitValue: 10, action: "block" });
      await useUp(context, lead.email);
      const body = await pauseThenApprove(context, cookie, lead.cookie);
      expect(body.nodeResults.find((entry) => entry.nodeId === "call")?.status).toBe("success");
    });

    it("are never refused in a resumed eval run", async () => {
      const { context, cookie } = await setup();
      const lead = await loginAs(context, "admin", "lead");
      await context.store.upsertWorkflow(modelChild("wf-child"));
      await context.store.upsertWorkflow(gatedCaller());
      // A project budget, used up while the run waits, would refuse any other run's child (see the first case).
      await createBudget(context, cookie, { name: "Project cap", scopeType: "project", scopeId: "default", period: "month", limitType: "tokens", limitValue: 10, action: "block" });
      const body = await pauseThenApprove(context, cookie, lead.cookie, async (executionId) => {
        await useUp(context, "admin@example.com");
        // The paused run is marked as an eval run's, as an eval run's pause records it.
        const pending = (await context.store.getWorkflowExecutionState(executionId))!;
        await context.store.saveWorkflowExecutionState({
          id: pending.id,
          workflowId: pending.workflowId,
          status: pending.status,
          waitingNodeId: pending.waitingNodeId,
          startedAt: pending.startedAt,
          ...(pending.triggerType ? { triggerType: pending.triggerType } : {}),
          ...(pending.triggeredBy ? { triggeredBy: pending.triggeredBy } : {}),
          state: { ...(pending.state as Record<string, unknown>), guardRunSource: "eval" }
        });
      });
      expect(body.nodeResults.find((entry) => entry.nodeId === "call")?.status).toBe("success");
    });
  });

  it("starts children as before when no budget applies", async () => {
    const { context, cookie } = await setup();
    await context.store.upsertWorkflow(modelChild("wf-child"));
    await context.store.upsertWorkflow(
      chain("wf-loop", [
        { id: "first", workflowId: "wf-child" },
        { id: "second", workflowId: "wf-child" }
      ])
    );
    // A block budget of another workflow does not apply.
    await createBudget(context, cookie, {
      name: "Other",
      scopeType: "workflow",
      scopeId: "wf-other",
      period: "month",
      limitType: "tokens",
      limitValue: 1,
      action: "block"
    });
    const body = (await execute(context, cookie, "wf-loop")).json<RunBody>();
    expect(body.status).toBe("success");
  });
});
