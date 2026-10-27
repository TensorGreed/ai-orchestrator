import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { APPROVAL_RESUME_MESSAGE, ARMED_RUN_TTL_MS, CREDENTIALS_MESSAGE, DEMO_STATE_STORAGE_KEY, NOT_IN_DEMO, createFakeBackend, graphDigest, shiftFixtures, type DemoNotice, type DemoStorage } from "./fake-backend";
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

/** The run input a workflow's recording answers. */
const recordedPrompt = (workflowId: string) => demoFixtures.runs[workflowId]!.prompt;
/** A run request as the studio sends it for the recorded question: the prompt and the recorded system prompt. */
const askedBody = (workflowId: string, userPrompt: unknown = recordedPrompt(workflowId)) => {
  const systemPrompt = demoFixtures.runs[workflowId]!.systemPrompt;
  return { user_prompt: userPrompt, ...(systemPrompt ? { system_prompt: systemPrompt } : {}) };
};
const asked = (workflowId: string) => JSON.stringify(askedBody(workflowId));

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
    const response = await demo.fetch("/api/workflows/wf-demo-support-agent/execute/stream", { method: "POST", body: asked("wf-demo-support-agent") });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = parseSse(await response.text());
    expect(frames.map((frame) => frame.event)).toEqual(recorded.frames.map((frame) => frame.event));
    expect(frames[0]!.event).toBe("execution_started");
    expect(frames.at(-1)!.event).toBe("result");
    expect(frames.at(-1)!.data.status).toBe("success");
    expect(frames.at(-1)!.data.executionId).toBe(recorded.executionId);
    const toolCalls = frames.filter((frame) => frame.event === "node_activity" && frame.data.kind === "tool_call" && frame.data.phase === "end");
    expect(toolCalls.map((frame) => [frame.data.toolName, frame.data.outcome])).toEqual([
      ["http_mcp__lookup_kb", "ok"],
      ["http_mcp__calculator", "error"],
      ["http_mcp__calculator", "ok"]
    ]);
    // Replayed frames carry the replay's time, not the recording's.
    const started = Date.parse(frames[0]!.data.startedAt);
    expect(Math.abs(Date.now() - started)).toBeLessThan(10_000);
  });

  it("drives the client's stream handlers to completion", async () => {
    backend();
    const seen: string[] = [];
    const result = await api.executeWorkflowStream("wf-demo-research-swarm", askedBody("wf-demo-research-swarm") as never, {
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
    await (await demo.fetch("/api/workflows/wf-demo-guarded-intake/execute/stream", { method: "POST", body: asked("wf-demo-guarded-intake") })).text();
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

    const refused = await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute/stream", askedBody("wf-demo-support-agent"));
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
    const replay = await demo.fetch("/api/workflows/wf-demo-support-agent/execute/stream", { method: "POST", body: asked("wf-demo-support-agent") });
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
    expect(notices[0]).toMatchObject({ kind: "run_not_recorded", similar: { executionId: demoFixtures.runs["wf-demo-support-agent"]!.executionId } });
  });

  it("replays a copy with the same graph, such as a duplicate", async () => {
    backend();
    const copy = await api.duplicateWorkflow("wf-demo-guarded-intake", { name: "Guarded intake copy" });
    const result = await api.executeWorkflowStream(copy.id, askedBody("wf-demo-guarded-intake") as never);
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


describe("runs answer only the recorded input", () => {
  it("replays when the input is the recorded one, after trimming and whitespace normalisation", async () => {
    const demo = backend();
    const prompt = recordedPrompt("wf-demo-support-agent");
    const spaced = `  ${prompt.replace(/ /g, "  \n ")}  `;
    const response = await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", askedBody("wf-demo-support-agent", spaced));
    expect(response.status).toBe(200);
    expect(response.body.output.result).toContain("$7,056");
    // Chat sends the same input under `user_prompt`; a webhook body may nest it.
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", { input: { user_prompt: prompt }, system_prompt: demoFixtures.runs["wf-demo-support-agent"]!.systemPrompt })).status).toBe(200);
  });

  it("refuses any other input with a typed answer that offers the recorded question", async () => {
    const notices: DemoNotice[] = [];
    const demo = backend({ notify: (notice) => notices.push(notice) });
    for (const body of [{ user_prompt: "Tell me a joke about penguins" }, { message: "Tell me a joke about penguins" }, {}, { user_prompt: "What time is it in America/Toronto? Use tools when needed." }]) {
      const refused = await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute/stream", body);
      expect(refused.status, JSON.stringify(body)).toBe(409);
      expect(refused.body).toMatchObject({ code: NOT_IN_DEMO, recordedInput: recordedPrompt("wf-demo-support-agent") });
      expect(refused.body.error).toContain("Runs need a real deployment");
      expect(refused.body.error).not.toContain("$7,056");
    }
    expect(notices.every((notice) => notice.kind === "input_not_recorded" && notice.recordedInput === recordedPrompt("wf-demo-support-agent"))).toBe(true);
    // Through the client, the chat's stream surfaces the refusal instead of an answer.
    await expect(api.executeWorkflowStream("wf-demo-support-agent", { user_prompt: "Tell me a joke about penguins" } as never)).rejects.toMatchObject({ status: 409 });
  });

  it("runs the recorded question once when the visitor asks for it, and only for that workflow", async () => {
    const demo = backend();
    expect(demo.armRecordedInput("wf-demo-support-agent")).toBe(recordedPrompt("wf-demo-support-agent"));
    // The editor sends its built-in prompt; the armed run is the recorded question instead.
    const editorRun = { user_prompt: "What time is it in America/Toronto? Use tools when needed." };
    const first = await demo.fetch("/api/workflows/wf-demo-support-agent/execute/stream", { method: "POST", body: JSON.stringify(editorRun) });
    expect(first.status).toBe(200);
    const frames = parseSse(await first.text());
    expect(frames.find((frame) => frame.event === "node_start")!.data.input.user_prompt).toBe(recordedPrompt("wf-demo-support-agent"));
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", editorRun)).status).toBe(409);

    expect(demo.armRecordedInput("wf-demo-guarded-intake")).not.toBeNull();
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", editorRun)).status).toBe(409);
    const workflow = { ...structuredClone(demoFixtures.workflows.workflows[0]!), id: "wf-new", name: "New", nodes: [], edges: [] } as Workflow;
    await call(demo, "POST", "/api/workflows", workflow);
    expect(demo.armRecordedInput("wf-new")).toBeNull();
  });
});

describe("the recorded question, asked for once", () => {
  const penguin = (workflowId = "wf-demo-support-agent") => askedBody(workflowId, "What is the capital of France?");

  it("is spent by the next run of any workflow, so a later message is refused", async () => {
    const demo = backend();
    expect(demo.armRecordedInput("wf-demo-support-agent")).not.toBeNull();
    // The click ran another workflow: the request for the support agent is gone with it.
    expect((await call(demo, "POST", "/api/workflows/wf-demo-guarded-intake/execute", penguin("wf-demo-guarded-intake"))).status).toBe(409);
    const later = await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute/stream", penguin());
    expect(later.status).toBe(409);
    expect(later.body.error).not.toContain("$7,056");
  });

  it("is spent by a run the demo refuses for its graph, and restoring the graph does not bring it back", async () => {
    const demo = backend();
    const workflow = await api.fetchWorkflow("wf-demo-support-agent");
    expect(demo.armRecordedInput("wf-demo-support-agent")).not.toBeNull();
    const edited = structuredClone(workflow);
    edited.nodes.find((node) => node.id === "output")!.config = { responseTemplate: "Edited: {{answer}}" };
    await api.updateWorkflow(edited);
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", penguin())).body).toMatchObject({ restorable: true });
    demo.restoreRecorded("wf-demo-support-agent");
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", penguin())).status).toBe(409);
  });

  it("holds only for the graph it was asked on", async () => {
    const demo = backend();
    expect(demo.armRecordedInput("wf-demo-support-agent")).not.toBeNull();
    const workflow = await api.fetchWorkflow("wf-demo-support-agent");
    const moved = { ...workflow, nodes: workflow.nodes.map((node) => (node.id === "output" ? { ...node, config: { responseTemplate: "Moved: {{answer}}" } } : node)) };
    await api.updateWorkflow(moved);
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", penguin())).status).toBe(409);
  });

  it("expires after a moment", async () => {
    let clock = Date.parse(demoFixtures.meta.recordedAt) + 60_000;
    const demo = createFakeBackend({ fixtures: demoFixtures, storage: null, pace: 0, now: () => new Date(clock) });
    expect(demo.armRecordedInput("wf-demo-support-agent")).not.toBeNull();
    clock += ARMED_RUN_TTL_MS + 1;
    expect((await demo.fetch("/api/workflows/wf-demo-support-agent/execute", { method: "POST", body: JSON.stringify(penguin()) })).status).toBe(409);
    expect(demo.armRecordedInput("wf-demo-support-agent")).not.toBeNull();
    clock += ARMED_RUN_TTL_MS - 100;
    expect((await demo.fetch("/api/workflows/wf-demo-support-agent/execute", { method: "POST", body: JSON.stringify(penguin()) })).status).toBe(200);
  });
});

describe("what a run request must match besides its input", () => {
  it("refuses partial and debug runs with the typed answer", async () => {
    const demo = backend();
    for (const extra of [{ startNodeId: "agent" }, { runMode: "single_node" }, { sourceExecutionId: demoFixtures.runs["wf-demo-support-agent"]!.executionId }]) {
      const refused = await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute/stream", { ...askedBody("wf-demo-support-agent"), ...extra });
      expect(refused.status, JSON.stringify(extra)).toBe(409);
      expect(refused.body).toMatchObject({ code: NOT_IN_DEMO, field: Object.keys(extra)[0] });
      expect(refused.body.error).toContain("Runs need a real deployment");
    }
    // An explicit whole-workflow run is a normal run.
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", { ...askedBody("wf-demo-support-agent"), runMode: "workflow" })).status).toBe(200);
  });

  it("requires the system prompt the run was recorded with", async () => {
    const demo = backend();
    const recorded = demoFixtures.runs["wf-demo-support-agent"]!;
    expect(recorded.systemPrompt).toBeTruthy();
    for (const systemPrompt of [undefined, "You are a pirate."]) {
      const body = { user_prompt: recorded.prompt, ...(systemPrompt ? { system_prompt: systemPrompt } : {}) };
      expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", body)).status, String(systemPrompt)).toBe(409);
    }
    expect((await call(demo, "POST", "/api/workflows/wf-demo-support-agent/execute", { user_prompt: recorded.prompt, system_prompt: `  ${recorded.systemPrompt}\n` })).status).toBe(200);
  });
});

describe("recorded writes", () => {
  const replayKey = Object.keys(demoFixtures.responses.post).find((key) => key.endsWith("/replay"))!;
  const replayUrl = replayKey.replace(/^POST /, "");

  it("returns the recorded replay diff for the recorded request on the recorded draft", async () => {
    const demo = backend();
    for (const body of [{ draft: true, mcpMode: "strict" }, { draft: true }, {}]) {
      const response = await call(demo, "POST", replayUrl, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(response.body.diff).toBeTruthy();
    }
    expect((await api.runReplay(replayUrl.split("/")[4]!, { draft: true, mcpMode: "strict" })).diff).toBeTruthy();
  });

  it("refuses the replay diff for another candidate, another MCP mode or a changed draft", async () => {
    const notices: DemoNotice[] = [];
    const demo = backend({ notify: (notice) => notices.push(notice) });
    expect((await call(demo, "POST", replayUrl, { version: 1, mcpMode: "strict" })).status).toBe(409);
    expect((await call(demo, "POST", replayUrl, { draft: true, mcpMode: "lenient" })).status).toBe(409);
    const workflow = await api.fetchWorkflow("wf-demo-faq-release");
    const edited = structuredClone(workflow);
    edited.nodes.find((node) => node.id === "output")!.config = { responseTemplate: "Changed: {{answer}}", outputKey: "result" };
    await api.updateWorkflow(edited);
    const refused = await call(demo, "POST", replayUrl, { draft: true, mcpMode: "strict" });
    expect(refused).toMatchObject({ status: 409, body: { code: NOT_IN_DEMO } });
    expect(refused.body.error).toContain("Runs need a real deployment");
    expect(notices.at(-1)).toMatchObject({ kind: "not_in_demo" });
  });

  it("returns the recorded publish verdict only for the recorded version of the recorded graph", async () => {
    const demo = backend();
    const recorded = demoFixtures.responses.post["POST /api/workflows/wf-demo-faq-release/publish"]!;
    const version = recorded.match.request.version as number;
    expect(await api.publishWorkflowVersion("wf-demo-faq-release", { version })).toMatchObject({ outcome: "blocked", reasons: expect.arrayContaining([expect.stringMatching(/regression/)]) });
    await expect(api.publishWorkflowVersion("wf-demo-faq-release", { version: version - 1 })).rejects.toMatchObject({ status: 409 });
    await expect(api.publishWorkflowVersion("wf-demo-faq-release", { version, override: { reason: "Ship it" } })).rejects.toMatchObject({ status: 409 });
    const workflow = await api.fetchWorkflow("wf-demo-faq-release");
    await api.updateWorkflow({ ...workflow, nodes: workflow.nodes.map((node) => (node.id === "output" ? { ...node, config: { responseTemplate: "{{answer}}" } } : node)) });
    expect((await call(demo, "POST", "/api/workflows/wf-demo-faq-release/publish", { version })).status).toBe(409);
  });
});

describe("approvals", () => {
  it("decides on demo data: approve, reject with a reason, one decision per request", async () => {
    const storage = memoryStorage();
    const notices: DemoNotice[] = [];
    backend({ storage, notify: (notice) => notices.push(notice) });
    const pending = (await api.listApprovals({ status: "pending" })).items;
    expect(pending).toHaveLength(2);
    expect(pending.every((item) => item.canDecide)).toBe(true);
    const decidedBefore = (await api.listApprovals({ status: "decided" })).items.length;

    const [first, second] = pending as Array<{ executionId: string; requestId: string }>;
    const approved = await api.approveApproval(first!.executionId, { requestId: first!.requestId, reason: "Looks right." });
    expect(notices.at(-1)).toEqual({ kind: "approval_decided", executionId: first!.executionId, message: `Approved on demo data. ${APPROVAL_RESUME_MESSAGE}` });
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
