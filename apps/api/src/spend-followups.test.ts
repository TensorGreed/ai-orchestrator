/**
 * Each model call is counted once in a run's usage and budgets: an Approval Gate (or another node that passes its
 * input on) does not repeat the usage of the model call before it, and a streamed model call that fails or times out
 * is charged an estimate (the prompt and what had streamed) instead of nothing.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { callAs, closeReleaseTestContext, createReleaseTestContext, loginAs, testNode, type ReleaseTestContext } from "./test-support/release.test-helper.js";

const contexts: ReleaseTestContext[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

async function setup(): Promise<{ context: ReleaseTestContext; cookie: string }> {
  const context = await createReleaseTestContext();
  contexts.push(context);
  const admin = await loginAs(context, "admin");
  return { context, cookie: admin.cookie };
}

const monthWindow = () => {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
  };
};

const usageOf = async (context: ReleaseTestContext, workflowId: string) => await context.store.queryBudgetUsage({ ...monthWindow(), workflowId });

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function workflow(id: string, nodes: Workflow["nodes"], edges: Array<[string, string, string?]>): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes,
    edges: edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) }))
  } as Workflow;
}

const echoModel = (id: string) => testNode(id, "llm_call", { provider: { providerId: "echo", model: "echo-1" }, userPromptTemplate: "Summarise the order history of a customer" });

describe("a model call before a pass-through node", { timeout: 20_000 }, () => {
  it("is counted once after an Approval Gate's approval resumes the run, and once before an If node", async () => {
    const { context, cookie } = await setup();
    // The tokens of one model call, measured on its own.
    await context.store.upsertWorkflow(workflow("wf-probe", [testNode("start", "manual_trigger"), echoModel("model"), testNode("out", "output")], [["start", "model"], ["model", "out"]]));
    expect((await callAs(context, "POST", "/api/workflows/wf-probe/execute", cookie, {})).statusCode).toBe(200);
    const perCall = (await usageOf(context, "wf-probe")).totalTokens;
    expect(perCall).toBeGreaterThan(0);

    await context.store.upsertWorkflow(
      workflow(
        "wf-gated",
        [testNode("start", "manual_trigger"), echoModel("model"), testNode("gate", "approval_gate", { message: "Send it?" }), testNode("out", "output")],
        [["start", "model"], ["model", "gate"], ["gate", "out", "approved"]]
      )
    );
    const paused = await callAs(context, "POST", "/api/workflows/wf-gated/execute", cookie, {});
    const { executionId, status } = paused.json<{ executionId: string; status: string }>();
    expect(status, paused.body).toBe("waiting_approval");
    const lead = await loginAs(context, "admin", "lead");
    const approved = await callAs(context, "POST", `/api/approvals/${executionId}/approve`, lead.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    await waitFor(async () => (await context.store.getExecutionHistory(executionId))?.status === "success");
    await waitFor(async () => (await usageOf(context, "wf-gated")).totalTokens > 0);
    expect((await usageOf(context, "wf-gated")).totalTokens).toBe(perCall);

    await context.store.upsertWorkflow(
      workflow(
        "wf-branch",
        [testNode("start", "manual_trigger"), echoModel("model"), testNode("check", "if_node", { condition: "true" }), testNode("out", "output")],
        [["start", "model"], ["model", "check"], ["check", "out", "true"]]
      )
    );
    expect((await callAs(context, "POST", "/api/workflows/wf-branch/execute", cookie, {})).statusCode).toBe(200);
    expect((await usageOf(context, "wf-branch")).totalTokens).toBe(perCall);
  });
});

/** An OpenAI-compatible server that streams the start of an answer and then breaks off (`cut`) or never ends (`hang`). */
async function startBrokenModelServer(mode: "cut" | "hang"): Promise<string> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "The first part of a long answer about the order history" } }] })}\n\n`);
      if (mode === "cut") setTimeout(() => response.destroy(), 20);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

function streamedWorkflow(baseUrl: string): Workflow {
  return workflow(
    "wf-broken-stream",
    [
      testNode("input", "text_input", { text: "Summarise the order history of a customer in a few words" }),
      testNode("llm", "llm_call", { provider: { providerId: "openai_compatible", model: "m", baseUrl }, promptKey: "text", retry: { enabled: false, maxAttempts: 1, delayMs: 1 } }),
      testNode("output", "output", { responseTemplate: "{{answer}}" })
    ],
    [["input", "llm"], ["llm", "output"]]
  );
}

describe("a streamed model call that does not finish", { timeout: 20_000 }, () => {
  it("is charged an estimate of the prompt and the partial answer, and a block budget then refuses the next run", async () => {
    const { context, cookie } = await setup();
    await context.store.upsertWorkflow(streamedWorkflow(await startBrokenModelServer("cut")));
    const budget = await callAs(context, "POST", "/api/budgets", cookie, {
      name: "Tiny",
      scopeType: "global",
      period: "month",
      limitType: "tokens",
      limitValue: 1,
      action: "block",
      warnThresholdPct: 0.8
    });
    expect(budget.statusCode, budget.body).toBeLessThan(300);

    const failed = await callAs(context, "POST", "/api/workflows/wf-broken-stream/execute/stream", cookie, { input: {} });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toContain("error");
    await waitFor(async () => (await usageOf(context, "wf-broken-stream")).totalTokens > 0);
    const [event] = await context.store.listUsageEvents({ workflowId: "wf-broken-stream" });
    expect(event).toMatchObject({ status: "error", llmCallCount: 1 });
    expect(event!.inputTokens).toBeGreaterThan(0);
    expect(event!.outputTokens).toBeGreaterThan(0);

    const refused = await callAs(context, "POST", "/api/workflows/wf-broken-stream/execute/stream", cookie, { input: {} });
    expect(refused.statusCode, refused.body).toBe(402);
  });

  it("is charged when the run's timeout stops it while the model answers", async () => {
    const { context, cookie } = await setup();
    await context.store.upsertWorkflow(streamedWorkflow(await startBrokenModelServer("hang")));
    const timedOut = await callAs(context, "POST", "/api/workflows/wf-broken-stream/execute/stream", cookie, { input: {}, executionTimeoutMs: 1_000 });
    expect(timedOut.statusCode).toBe(200);
    await waitFor(async () => (await usageOf(context, "wf-broken-stream")).totalTokens > 0);
    const [event] = await context.store.listUsageEvents({ workflowId: "wf-broken-stream" });
    expect(event!.inputTokens).toBeGreaterThan(0);
    expect(event!.llmCallCount).toBe(1);
  });
});
