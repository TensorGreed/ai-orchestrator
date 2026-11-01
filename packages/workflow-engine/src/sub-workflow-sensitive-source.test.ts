import { describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { SENSITIVE_OUTPUT_CONFIG_KEY } from "@ai-orchestrator/shared";
import { workflowDeclaresSensitiveSource } from "./executor.js";

const call = (workflowId: string) => ({ type: "execute_workflow", config: { workflowId } }) as never;
const plain = { type: "output", config: {} } as never;
const sensitive = { type: "output", config: { [SENSITIVE_OUTPUT_CONFIG_KEY]: true } } as never;
const wf = (nodes: unknown[]) => ({ nodes }) as unknown as Workflow;

describe("workflowDeclaresSensitiveSource and sub-workflows", () => {
  it("walks a called sub-workflow, to any level", async () => {
    const all: Record<string, Workflow> = { a: wf([call("b")]), b: wf([plain, sensitive]) };
    const loadWorkflow = async (id: string) => all[id];
    expect(await workflowDeclaresSensitiveSource([call("a")], { loadWorkflow })).toBe(true);
    expect(await workflowDeclaresSensitiveSource([call("b")], { loadWorkflow: async () => wf([plain]) })).toBe(false);
  });

  it("does not loop on a cycle, and a cycle alone is not sensitive", async () => {
    const all: Record<string, Workflow> = { a: wf([call("b")]), b: wf([call("a")]) };
    expect(await workflowDeclaresSensitiveSource([call("a")], { loadWorkflow: async (id) => all[id] })).toBe(false);
  });

  it("fails closed: a sub-workflow that is missing or cannot be loaded, or no loader, counts as sensitive", async () => {
    expect(await workflowDeclaresSensitiveSource([call("a")], { loadWorkflow: async () => undefined })).toBe(true);
    expect(await workflowDeclaresSensitiveSource([call("a")], { loadWorkflow: async () => { throw new Error("denied"); } })).toBe(true);
    expect(await workflowDeclaresSensitiveSource([call("a")], {})).toBe(true);
  });

  it("fails closed at the depth cap", async () => {
    const loadWorkflow = async (id: string) => wf([call(`${id}x`)]);
    expect(await workflowDeclaresSensitiveSource([call("a")], { loadWorkflow })).toBe(true);
  });
});
