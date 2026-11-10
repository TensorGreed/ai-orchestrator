/**
 * 13.3 — store contract: the deletion paths outside retention and the explicit deletes, on both stores (the review's
 * repro, now asserting they are closed). A held workflow cannot leave its project; an MCP server delete keeps held
 * tool calls; removing gate cases refuses a held case; the gateway-approval sweep keeps held approvals; held agent
 * memory only grows; workflow versions are not pruned under a hold.
 */
import { expect, it } from "vitest";
import type { ChatMessage } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";
import { retentionRowSql as insert } from "../../test-support/retention-rows.js";
import { LegalHoldError, mergeHeldMemory } from "../legal-hold-sql.js";
import type { Store } from "../store.js";

const OLD = "2001-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";

function workflow(id: string, projectId: string) {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId } as never;
}

async function hold(store: Store, scopeType: "project" | "workflow", scopeId: string) {
  return await store.placeLegalHold({
    id: `h-${scopeType}-${scopeId}`,
    name: "H",
    reason: "r",
    matterRef: null,
    scopeType,
    scopeId,
    endsAt: null,
    createdBy: null,
    createdAt: new Date().toISOString(),
    items: []
  });
}

const message = (role: "user" | "assistant", content: string): ChatMessage => ({ role, content }) as ChatMessage;

describeStoreContract("legal holds: other deletion paths", (ctx) => {
  const sql = () => testSql(ctx.store());

  it("a workflow under a project hold cannot move to another project; its runs stay held; released, it moves", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "Held" });
    await store.upsertProject({ id: "other", name: "Free" });
    await store.upsertWorkflow(workflow("wf", "proj"));
    await sql().run(insert("execution_history", "run1", OLD));
    await sql().run(`UPDATE execution_history SET workflow_id = 'wf' WHERE id = 'run1'`);
    const placed = await hold(store, "project", "proj");
    await expect(store.upsertWorkflow(workflow("wf", "other"))).rejects.toBeInstanceOf(LegalHoldError);
    await expect(store.upsertWorkflow(workflow("wf", "other"))).rejects.toThrow(/cannot be moved to another project/);
    expect((await store.getWorkflow("wf"))?.projectId).toBe("proj");
    // A save in the same project is fine.
    expect((await store.upsertWorkflow(workflow("wf", "proj"))).projectId).toBe("proj");
    expect(await store.pruneRetentionTable("execution_history", { before: CUT, limit: 100 })).toBe(0);
    await expect(store.deleteWorkflow("wf")).rejects.toBeInstanceOf(LegalHoldError);
    await store.releaseLegalHold({ id: placed.id, releasedBy: null, releasedAt: new Date().toISOString(), reason: "done" });
    expect((await store.upsertWorkflow(workflow("wf", "other"))).projectId).toBe("other");
  });

  it("deleting an MCP server keeps the held tool calls and deletes the others", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "Held" });
    await store.createMcpServer({ id: "srv", name: "S", adapterId: "mock-mcp" } as never);
    await sql().run(insert("mcp_tool_calls", "tc-held", OLD));
    await sql().run(insert("mcp_tool_calls", "tc-free", OLD));
    await sql().run(`UPDATE mcp_tool_calls SET workflow_id = 'wf-x', project_id = 'proj', registry_server_id = 'srv' WHERE id = 'tc-held'`);
    await sql().run(`UPDATE mcp_tool_calls SET workflow_id = 'wf-y', project_id = 'free', registry_server_id = 'srv' WHERE id = 'tc-free'`);
    await hold(store, "project", "proj");
    expect(await store.deleteMcpServer("srv")).toBe(true);
    expect((await sql().all<{ id: string }>(`SELECT id FROM mcp_tool_calls ORDER BY id`)).map((row) => row.id)).toEqual(["tc-held"]);
  });

  it("removing a held golden-set case at the gate is refused and removes nothing", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "P" });
    await store.upsertWorkflow(workflow("wf", "proj"));
    await store.createEvalDataset({ id: "ds", name: "Set", workflowId: "wf" } as never);
    await store.createEvalFixture({ id: "fx", datasetId: "ds", name: "case", input: {} } as never);
    await store.createEvalFixture({ id: "fx2", datasetId: "ds", name: "case 2", input: {} } as never);
    const placed = await hold(store, "workflow", "wf");
    await expect(store.deleteEvalFixture("fx")).rejects.toThrow(/legal hold/);
    await expect(
      store.updateReleaseGateCases({ workflowId: "wf", deleteFixtureIds: ["fx2", "fx"], updatedAt: new Date().toISOString(), updatedBy: null })
    ).rejects.toBeInstanceOf(LegalHoldError);
    expect(await store.getEvalFixture("fx")).not.toBeNull();
    expect(await store.getEvalFixture("fx2")).not.toBeNull();
    await store.releaseLegalHold({ id: placed.id, releasedBy: null, releasedAt: new Date().toISOString(), reason: "done" });
    expect(await store.updateReleaseGateCases({ workflowId: "wf", deleteFixtureIds: ["fx"], updatedAt: new Date().toISOString(), updatedBy: null })).toBe("ok");
    expect(await store.getEvalFixture("fx")).toBeNull();
  });

  it("the gateway-approval sweep keeps held approvals", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "Held" });
    await sql().run(insert("mcp_gateway_approvals", "ga-held", OLD));
    await sql().run(insert("mcp_gateway_approvals", "ga-free", OLD));
    await sql().run(`UPDATE mcp_gateway_approvals SET project_id = 'proj', status = 'approved', expires_at = '${OLD}' WHERE id = 'ga-held'`);
    await sql().run(`UPDATE mcp_gateway_approvals SET project_id = 'free', status = 'approved', expires_at = '${OLD}' WHERE id = 'ga-free'`);
    await hold(store, "project", "proj");
    await store.listMcpGatewayApprovals({}, new Date().toISOString());
    expect((await sql().all<{ id: string }>(`SELECT id FROM mcp_gateway_approvals ORDER BY id`)).map((row) => row.id)).toEqual(["ga-held"]);
  });

  it("held agent memory only grows: a trimmed save keeps the earlier messages; unheld memory is replaced as before", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "P" });
    await store.upsertWorkflow(workflow("wf", "proj"));
    const turns = [message("user", "one"), message("assistant", "two"), message("user", "three")];
    await store.saveSessionMemory("wf:agent", "s1", turns);
    await store.saveSessionMemory("free:agent", "s1", turns);
    await hold(store, "workflow", "wf");
    // The runtime keeps its last two messages and adds the new turn.
    const next = [turns[1]!, turns[2]!, message("assistant", "four")];
    await store.saveSessionMemory("wf:agent", "s1", next);
    await store.saveSessionMemory("free:agent", "s1", next);
    expect((await store.loadSessionMemory("wf:agent", "s1")).map((m) => m.content)).toEqual(["one", "two", "three", "four"]);
    expect((await store.loadSessionMemory("free:agent", "s1")).map((m) => m.content)).toEqual(["two", "three", "four"]);
  });

  it("workflow versions are not pruned while a hold covers the workflow", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "P" });
    await store.upsertWorkflow(workflow("wf", "proj"));
    const append = async (n: number) =>
      await store.appendWorkflowVersion({ id: `v${n}`, workflowId: "wf", workflowJson: "{}", createdBy: null, changeNote: null, retention: 2 });
    await append(1);
    await append(2);
    const placed = await hold(store, "workflow", "wf");
    await append(3);
    await append(4);
    expect(await store.pruneWorkflowVersions("wf", 1)).toBe(0);
    expect((await store.listWorkflowVersions("wf", 50)).length).toBe(4);
    await store.releaseLegalHold({ id: placed.id, releasedBy: null, releasedAt: new Date().toISOString(), reason: "done" });
    expect(await store.pruneWorkflowVersions("wf", 2)).toBe(2);
  });
});

it("mergeHeldMemory appends after the overlap and never drops a stored message", () => {
  const a = { role: "user", content: "a" };
  const b = { role: "assistant", content: "b" };
  const c = { role: "user", content: "c" };
  expect(mergeHeldMemory([a, b], [b, c])).toEqual([a, b, c]);
  expect(mergeHeldMemory([a, b], [a, b, c])).toEqual([a, b, c]);
  expect(mergeHeldMemory([a, b], [c])).toEqual([a, b, c]);
  expect(mergeHeldMemory([], [a])).toEqual([a]);
  expect(mergeHeldMemory([a], [])).toEqual([a]);
});
