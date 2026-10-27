import { describe, expect, it } from "vitest";
import { approvalGateConfigSchema, dataDestinationRowSchema, guardNodeConfigSchema, nodeDefinitions, workflowSchema } from "@ai-orchestrator/shared";
import { demoFixtures } from "./fixtures";
import { findLeaks } from "./leak-patterns";
import meta from "./fixtures/meta.json?raw";
import workflows from "./fixtures/workflows.json?raw";
import runs from "./fixtures/runs.json?raw";
import responses from "./fixtures/responses.json?raw";
import studioSource from "../App.tsx?raw";

const raw = [meta, workflows, runs, responses].join("\n");
const get = (key: string) => demoFixtures.responses.get[key]?.body as any;

describe("demo fixtures", () => {
  it("stay small", () => {
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  it("are workflows the shared schema accepts, built from known node types", () => {
    const known = new Set(nodeDefinitions.map((definition) => definition.type));
    for (const workflow of demoFixtures.workflows.workflows) {
      const parsed = workflowSchema.safeParse(workflow);
      expect(parsed.success, `${workflow.id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
      for (const node of workflow.nodes) {
        expect(known.has(node.type), `${workflow.id}/${node.id}: ${node.type}`).toBe(true);
        if (node.type === "approval_gate") expect(approvalGateConfigSchema.safeParse(node.config).success).toBe(true);
        if (node.type === "guard") expect(guardNodeConfigSchema.safeParse(node.config).success).toBe(true);
      }
    }
    expect(demoFixtures.workflows.workflowList.map((item) => item.id).sort()).toEqual(demoFixtures.workflows.workflows.map((workflow) => workflow.id).sort());
  });

  it("have templates whose workflow JSON the shared schema accepts", () => {
    const templates = get("GET /api/templates").templates as Array<{ id: string }>;
    expect(templates.length).toBeGreaterThan(5);
    for (const template of templates) {
      const detail = get(`GET /api/templates/${template.id}`) as { workflowJson: string };
      const parsed = JSON.parse(detail.workflowJson) as { schemaVersion: string; workflowVersion: number; workflow: Record<string, unknown> };
      expect(workflowSchema.safeParse({ schemaVersion: parsed.schemaVersion, workflowVersion: parsed.workflowVersion, ...parsed.workflow }).success, template.id).toBe(true);
    }
  });

  it("have data destinations the shared schema accepts", () => {
    const rows = get("GET /api/data-destinations").destinations as unknown[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(dataDestinationRowSchema.safeParse(row).success, JSON.stringify(row)).toBe(true);
  });

  it("record the runs the demo story needs", () => {
    const result = (workflowId: string) => demoFixtures.runs[workflowId]!.frames.find((frame) => frame.event === "result")!.data as { status: string; executionId: string };
    for (const [workflowId, run] of Object.entries(demoFixtures.runs)) {
      expect(demoFixtures.workflows.workflows.some((workflow) => workflow.id === workflowId), workflowId).toBe(true);
      expect(run.frames[0]!.event).toBe("execution_started");
      expect(run.frames.at(-1)!.event).toBe("result");
      expect(result(workflowId).executionId).toBe(run.executionId);
    }
    expect(result("wf-demo-support-agent").status).toBe("success");
    expect(result("wf-demo-refund-approval").status).toBe("waiting_approval");
    const activity = (workflowId: string) => demoFixtures.runs[workflowId]!.frames.filter((frame) => frame.event === "node_activity").map((frame) => frame.data as { kind: string; toolName?: string; outcome?: string });
    expect(activity("wf-demo-support-agent").filter((entry) => entry.kind === "tool_call" && entry.outcome === "ok")).toHaveLength(2);
    // The registered MCP server refuses one calculator expression; the agent retries it.
    expect(activity("wf-demo-support-agent").filter((entry) => entry.kind === "tool_call" && entry.outcome === "error").map((entry) => entry.toolName)).toEqual(["http_mcp__calculator"]);
    expect(activity("wf-demo-research-swarm").filter((entry) => entry.kind === "tool_call" && entry.toolName?.startsWith("delegate_to_") && entry.outcome === "ok")).toHaveLength(2);
    const guardEvents = get("GET /api/guard/events?workflowId=wf-demo-guarded-intake").events as Array<{ effectiveAction: string }>;
    expect(guardEvents.some((event) => event.effectiveAction === "block")).toBe(true);
    expect(demoFixtures.responses.post["POST /api/workflows/wf-demo-faq-release/publish"]).toMatchObject({ status: 409, body: { verdict: "blocked" } });
    const replay = Object.entries(demoFixtures.responses.post).find(([key]) => key.endsWith("/replay"))![1];
    expect((replay.body as { diff?: unknown }).diff).toBeTruthy();
    // Recorded writes say what they were made against, so the demo can tell when they no longer apply.
    for (const [key, write] of Object.entries(demoFixtures.responses.post)) {
      const workflow = demoFixtures.workflows.workflows.find((entry) => entry.id === write.match.workflowId);
      expect(workflow, key).toBeTruthy();
      expect(write.match.graph.nodes.length, key).toBeGreaterThan(0);
    }
  });

  it("record each run with the system prompt the studio sends for it", () => {
    // The editor and chat defaults in App.tsx; a run must match the one it was recorded with.
    const defaults = [...studioSource.matchAll(/const \[(?:systemPrompt|chatSystemPrompt), set\w+\] = useState\("([^"]*)"\)/g)].map((match) => match[1]);
    expect(defaults).toHaveLength(2);
    expect(new Set(defaults).size).toBe(1);
    for (const [workflowId, run] of Object.entries(demoFixtures.runs)) {
      expect(run.systemPrompt === null || run.systemPrompt === defaults[0], workflowId).toBe(true);
    }
    expect(demoFixtures.runs["wf-demo-support-agent"]!.systemPrompt).toBe(defaults[0]);
  });

  it("hold no credentials, private hosts or real addresses", () => {
    // The same patterns the recorder refuses; it also checks this machine's paths, names and keys.
    expect(findLeaks(raw)).toEqual([]);
    expect(raw).not.toMatch(/127\.0\.0\.1:(?!7001\b)\d{2,5}/);
    for (const email of raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
      expect(email, email).toMatch(/@example\.(com|org)$/);
    }
  });
});
