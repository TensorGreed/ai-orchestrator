import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { CREDENTIALS_MESSAGE, DEMO_STATE_STORAGE_KEY, NOT_IN_DEMO, createFakeBackend, graphDigest, shiftFixtures, type DemoNotice, type DemoStorage } from "./fake-backend";
import { demoFixtures } from "./fixtures";

const transport = vi.hoisted(() => ({ backend: null as null | { fetch: (input: string, init?: RequestInit) => Promise<Response>; openEventSource: (url: string) => EventSource } }));

vi.mock("../lib/transport", () => ({
  apiFetch: (input: string, init?: RequestInit) => transport.backend!.fetch(input, init),
  openEventSource: (url: string) => transport.backend!.openEventSource(url)
}));

const api = await import("../lib/api");

function memoryStorage(): DemoStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  };
}

function backend(options: { storage?: DemoStorage | null; notify?: (notice: DemoNotice) => void } = {}) {
  const created = createFakeBackend({ fixtures: demoFixtures, storage: options.storage ?? memoryStorage(), pace: 0, ...(options.notify ? { notify: options.notify } : {}) });
  transport.backend = created;
  return created;
}

async function call(target: ReturnType<typeof backend>, method: string, url: string, body?: unknown) {
  const response = await target.fetch(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function parseSse(text: string): Array<{ event: string; data: any }> {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      return { event: lines[0]!.slice("event: ".length), data: JSON.parse(lines[1]!.slice("data: ".length)) };
    });
}

afterEach(() => {
  transport.backend = null;
});

describe("workflows", () => {
  it("lists, creates, reads, updates, duplicates and deletes", async () => {
    const demo = backend();
    const list = await api.fetchWorkflows({ projectId: "default" });
    expect(list.map((item) => item.id)).toEqual(expect.arrayContaining(["wf-demo-support-agent", "wf-demo-research-swarm", "wf-demo-guarded-intake", "wf-demo-refund-approval", "wf-demo-faq-release"]));

    const draft = { ...structuredClone(demoFixtures.workflows.workflows.find((w) => w.id === "wf-basic-llm")!), id: "wf-mine", name: "Mine" } as Workflow;
    const created = await api.saveWorkflow(draft);
    expect(created).toMatchObject({ id: "wf-mine", name: "Mine", projectId: "default" });
    expect((await api.fetchWorkflow("wf-mine")).name).toBe("Mine");
    expect((await api.fetchWorkflows({ search: "mine" })).map((item) => item.id)).toEqual(["wf-mine"]);

    const updated = await api.updateWorkflow({ ...created, name: "Mine, renamed" });
    expect(updated.name).toBe("Mine, renamed");

    const copy = await api.duplicateWorkflow("wf-mine", { name: "Mine copy" });
    expect(copy.id).not.toBe("wf-mine");
    expect(copy.name).toBe("Mine copy");
    expect(copy.nodes).toEqual(updated.nodes);

    expect(await api.deleteWorkflow("wf-mine")).toEqual({ ok: true });
    await expect(api.fetchWorkflow("wf-mine")).rejects.toMatchObject({ status: 404 });
    expect(demo.workflows().some((workflow) => workflow.id === copy.id)).toBe(true);
  });

  it("imports exported JSON, refuses what is not a workflow, and never overwrites an existing id", async () => {
    backend();
    const original = demoFixtures.workflows.workflows.find((w) => w.id === "wf-demo-support-agent")!;
    const exported = JSON.stringify({ schemaVersion: "1.0.0", workflowVersion: 1, workflow: original });
    const imported = await api.importWorkflow({ json: exported });
    expect(imported.id).not.toBe(original.id);
    expect(imported.name).toBe(original.name);
    await expect(api.importWorkflow({ json: "{not json" })).rejects.toMatchObject({ status: 400 });
    await expect(api.importWorkflow({ workflow: { name: "x" } })).rejects.toMatchObject({ status: 400 });
  });

  it("makes a workflow from a template", async () => {
    const demo = backend();
    const templates = (await call(demo, "GET", "/api/templates")).body.templates as Array<{ id: string; name: string }>;
    const basic = templates.find((template) => template.name === "Basic LLM Flow")!;
    const used = await api.useTemplate(basic.id);
    expect(used.name).toBe("Basic LLM Flow");
    expect((await api.fetchWorkflow(used.workflowId)).nodes.length).toBeGreaterThan(0);
  });

  it("persists to storage, survives a new page, and resets to the fixtures", async () => {
    const storage = memoryStorage();
    const first = backend({ storage });
    const workflow = { ...structuredClone(demoFixtures.workflows.workflows[0]!), id: "wf-persisted", name: "Persisted" } as Workflow;
    await call(first, "POST", "/api/workflows", workflow);
    expect(storage.data.get(DEMO_STATE_STORAGE_KEY)).toContain("wf-persisted");

    const second = backend({ storage });
    expect((await call(second, "GET", "/api/workflows/wf-persisted")).status).toBe(200);

    second.reset();
    expect(storage.data.has(DEMO_STATE_STORAGE_KEY)).toBe(false);
    expect((await call(second, "GET", "/api/workflows/wf-persisted")).status).toBe(404);
    expect(second.workflows().map((entry) => entry.id).sort()).toEqual(demoFixtures.workflows.workflows.map((entry) => entry.id).sort());
  });

  it("ignores state saved against another recording, and works when storage throws", async () => {
    const storage = memoryStorage();
    storage.setItem(DEMO_STATE_STORAGE_KEY, JSON.stringify({ recordedAt: "2000-01-01T00:00:00.000Z", workflows: [], decisions: {}, seq: 0 }));
    const demo = backend({ storage });
    expect(demo.workflows().length).toBe(demoFixtures.workflows.workflows.length);

    const broken: DemoStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      }
    };
    const memoryOnly = backend({ storage: broken });
    const workflow = { ...structuredClone(demoFixtures.workflows.workflows[0]!), id: "wf-memory", name: "Memory" } as Workflow;
    expect((await call(memoryOnly, "POST", "/api/workflows", workflow)).status).toBe(200);
    expect((await call(memoryOnly, "GET", "/api/workflows/wf-memory")).status).toBe(200);
    expect(() => memoryOnly.reset()).not.toThrow();
  });
});

describe("what the demo does not do", () => {
  it("answers credential routes with a typed not-in-demo error the client surfaces", async () => {
    const demo = backend();
    for (const [method, url] of [
      ["POST", "/api/auth/login"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/register"],
      ["GET", "/api/secrets"],
      ["POST", "/api/secrets"],
      ["GET", "/api/auth/api-keys"],
      ["GET", "/api/users"],
      ["POST", "/api/providers/test"]
    ] as const) {
      const response = await call(demo, method, url, method === "POST" ? {} : undefined);
      expect(response.status, `${method} ${url}`).toBe(403);
      expect(response.body).toEqual({ error: CREDENTIALS_MESSAGE, code: NOT_IN_DEMO });
    }
    const error = await api.loginUser({ email: "someone@example.com", password: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(api.ApiError);
    expect(error).toMatchObject({ status: 403, message: CREDENTIALS_MESSAGE, payload: { code: NOT_IN_DEMO } });
  });

  it("answers anything unrecorded with 501 not_in_demo and remembers it", async () => {
    const demo = backend();
    const response = await call(demo, "GET", "/api/nothing-recorded-here");
    expect(response).toMatchObject({ status: 501, body: { code: NOT_IN_DEMO } });
    expect((await call(demo, "POST", "/api/knowledge-bases", { name: "x" })).status).toBe(501);
    expect(demo.misses()).toEqual(["GET /api/nothing-recorded-here", "POST /api/knowledge-bases"]);
  });

  it("signs in as the recorded demo user", async () => {
    backend();
    expect((await api.fetchAuthMe()).user).toEqual(demoFixtures.meta.user);
  });

  it("answers a new workflow's per-workflow reads with the empty state of a never-saved workflow", async () => {
    const demo = backend();
    const workflow = { ...structuredClone(demoFixtures.workflows.workflows[0]!), id: "wf-new", name: "New" } as Workflow;
    await call(demo, "POST", "/api/workflows", workflow);
    const state = await call(demo, "GET", "/api/workflows/wf-new/release-state");
    expect(state).toMatchObject({ status: 200, body: { state: { publishedVersion: null, gateEnabled: false } } });
    expect((await call(demo, "GET", "/api/workflows/wf-new/release-gate")).body.gate.workflowId).toBe("wf-new");
    expect((await call(demo, "GET", "/api/replay/recordings?workflowId=wf-new")).body).toEqual({ items: [], total: 0 });
  });
});

describe("runs", () => {
  it("replays the recorded stream in order and finishes with the recorded result", async () => {
    const demo = backend();
    const recorded = demoFixtures.runs["wf-demo-support-agent"]!;
    const response = await demo.fetch("/api/workflows/wf-demo-support-agent/execute/stream", { method: "POST", body: "{}" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = parseSse(await response.text());
    expect(frames.map((frame) => frame.event)).toEqual(recorded.frames.map((frame) => frame.event));
    expect(frames[0]!.event).toBe("execution_started");
    expect(frames.at(-1)!.event).toBe("result");
    expect(frames.at(-1)!.data.status).toBe("success");
    expect(frames.at(-1)!.data.executionId).toBe(recorded.executionId);
    const toolCalls = frames.filter((frame) => frame.event === "node_activity" && frame.data.kind === "tool_call" && frame.data.phase === "end");
    expect(toolCalls.map((frame) => frame.data.toolName)).toEqual(["mock-mcp__lookup_kb", "mock-mcp__calculator"]);
    // Replayed frames carry the replay's time, not the recording's.
    const started = Date.parse(frames[0]!.data.startedAt);
    expect(Math.abs(Date.now() - started)).toBeLessThan(10_000);
  });

  it("drives the client's stream handlers to completion", async () => {
    backend();
    const seen: string[] = [];
    const result = await api.executeWorkflowStream("wf-demo-research-swarm", { input: {} } as never, {
      onExecutionStarted: () => seen.push("started"),
      onNodeStart: (event) => seen.push(`start:${event.nodeId}`),
      onNodeComplete: (event) => seen.push(`complete:${event.nodeId}`),
      onNodeActivity: () => seen.push("activity")
    });
    expect(result.status).toBe("success");
    expect(seen[0]).toBe("started");
    expect(seen.indexOf("start:supervisor")).toBeLessThan(seen.lastIndexOf("complete:supervisor"));
    expect(seen.filter((entry) => entry === "activity").length).toBeGreaterThan(5);
  });

  it("paces the replay through the delay it is given", async () => {
    const delays: number[] = [];
    const demo = createFakeBackend({ fixtures: demoFixtures, storage: null, delay: async (ms) => void delays.push(ms) });
    await (await demo.fetch("/api/workflows/wf-demo-guarded-intake/execute/stream", { method: "POST" })).text();
    expect(delays).toHaveLength(demoFixtures.runs["wf-demo-guarded-intake"]!.frames.length);
    expect(delays.every((ms) => ms > 0)).toBe(true);
  });

  it("never fakes a run: an edited workflow gets a typed refusal, and restoring it replays again", async () => {
    const notices: DemoNotice[] = [];
    const demo = backend({ notify: (notice) => notices.push(notice) });
    const workflow = await api.fetchWorkflow("wf-demo-support-agent");
    const edited = structuredClone(workflow);
    edited.nodes.find((node) => node.id === "output")!.config = { responseTemplate: "Changed: {{answer}}" };
    await api.updateWorkflow(edited);

    const refused = await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute/stream", {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: NOT_IN_DEMO, restorable: true });
    expect(refused.body.error).toContain("Runs need a real deployment");
    expect(notices).toEqual([expect.objectContaining({ kind: "run_not_recorded", workflowId: "wf-demo-support-agent", restorable: true })]);

    // Moving nodes or renaming them does not change what a run does.
    const moved = structuredClone(workflow);
    moved.nodes.forEach((node) => {
      node.position = { x: node.position.x + 50, y: node.position.y };
      node.name = `${node.name}!`;
    });
    expect(graphDigest(moved)).toBe(graphDigest(workflow));

    expect(demo.restoreRecorded("wf-demo-support-agent")).toBe(true);
    const replay = await demo.fetch("/api/workflows/wf-demo-support-agent/execute/stream", { method: "POST" });
    expect(replay.status).toBe(200);
  });

  it("points a new workflow at the recorded run of the most similar one", async () => {
    const notices: DemoNotice[] = [];
    const demo = backend({ notify: (notice) => notices.push(notice) });
    const base = structuredClone(demoFixtures.workflows.workflows.find((w) => w.id === "wf-demo-support-agent")!);
    base.id = "wf-other";
    base.nodes = base.nodes.filter((node) => node.id !== "calc");
    base.edges = base.edges.filter((edge) => edge.target !== "calc");
    await call(demo, "POST", "/api/workflows", base);
    const refused = await call(demo, "POST", "/api/workflows/wf-other/execute", {});
    expect(refused.status).toBe(409);
    expect(refused.body.restorable).toBe(false);
    expect(refused.body.similar).toMatchObject({ workflowId: "wf-demo-support-agent" });
    expect(refused.body.error).toContain("Here is a recorded run of a similar workflow");
    expect(notices[0]!.similar?.executionId).toBe(demoFixtures.runs["wf-demo-support-agent"]!.executionId);
  });

  it("replays a copy with the same graph, such as a duplicate", async () => {
    backend();
    const copy = await api.duplicateWorkflow("wf-demo-guarded-intake", { name: "Guarded intake copy" });
    const result = await api.executeWorkflowStream(copy.id, {} as never);
    expect(result.output).toEqual({ result: "Blocked by the prompt guard." });
  });

  it("follows a recorded replay job's event stream to done", async () => {
    const demo = backend();
    const runs = (await call(demo, "GET", "/api/replay/runs")).body.runs as Array<{ id: string }>;
    expect(runs.length).toBeGreaterThan(0);
    const event = await new Promise<{ type: string; run: { id: string; status: string } }>((resolve) => api.subscribeEvalRun(runs[0]!.id, (update) => update.type === "done" && resolve(update as never)));
    expect(event.run).toMatchObject({ id: runs[0]!.id, status: "completed" });
  });
});

describe("approvals", () => {
  it("decides on demo data: approve, reject with a reason, one decision per request", async () => {
    const storage = memoryStorage();
    backend({ storage });
    const pending = (await api.listApprovals({ status: "pending" })).items;
    expect(pending).toHaveLength(2);
    expect(pending.every((item) => item.canDecide)).toBe(true);
    const decidedBefore = (await api.listApprovals({ status: "decided" })).items.length;

    const [first, second] = pending as Array<{ executionId: string; requestId: string }>;
    const approved = await api.approveApproval(first!.executionId, { requestId: first!.requestId, reason: "Looks right." });
    expect(approved).toEqual({ queued: true, executionId: first!.executionId, requestId: first!.requestId, decision: "approve" });
    await expect(api.approveApproval(first!.executionId, {})).rejects.toMatchObject({ status: 409 });

    await expect(api.rejectApproval(second!.executionId, {})).rejects.toMatchObject({ status: 400 });
    await api.rejectApproval(second!.executionId, { reason: "Over the limit." });

    expect((await api.listApprovals({ status: "pending" })).items).toHaveLength(0);
    const decided = (await api.listApprovals({ status: "decided" })).items as Array<{ executionId: string; status: string; reason: string | null }>;
    expect(decided).toHaveLength(decidedBefore + 2);
    expect(decided.find((item) => item.executionId === second!.executionId)).toMatchObject({ status: "rejected", reason: "Over the limit." });

    // Decisions persist like workflows do.
    backend({ storage });
    expect((await api.listApprovals({ status: "pending" })).items).toHaveLength(0);
  });
});

describe("recorded time", () => {
  it("moves recorded instants and days forward to the visit, keeping their spacing", () => {
    const recordedAt = Date.parse(demoFixtures.meta.recordedAt);
    const visit = new Date(recordedAt + 40 * 86_400_000);
    const shifted = shiftFixtures(demoFixtures, visit);
    expect(shifted.meta.recordedAt).toBe(demoFixtures.meta.recordedAt);
    const before = demoFixtures.runs["wf-demo-support-agent"]!.frames[0]!.data as { startedAt: string };
    const after = shifted.runs["wf-demo-support-agent"]!.frames[0]!.data as { startedAt: string };
    expect(Date.parse(after.startedAt) - Date.parse(before.startedAt)).toBe(visit.getTime() - recordedAt);
    expect(shiftFixtures(demoFixtures, new Date(recordedAt))).toBe(demoFixtures);
  });
});
