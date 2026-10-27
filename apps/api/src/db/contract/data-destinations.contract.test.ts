/**
 * Phase 13.1 — store contract: data destinations (CRUD, list order, exact match) and the workflow configs the
 * "not classified yet" list reads, on SQLite and Postgres.
 */
import { expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { DataDestinationWrite } from "../database.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const write = (overrides: Partial<DataDestinationWrite> = {}): DataDestinationWrite => ({
  name: "Model",
  kind: "model_provider",
  targetId: null,
  host: "api.example.com",
  tier: "vendor",
  region: "eu",
  holdsDataClasses: ["email"],
  note: null,
  ...overrides
});

function workflow(id: string, name: string): Workflow {
  return { id, name, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as unknown as Workflow;
}

describeStoreContract("store contract: data destinations", (ctx) => {
  it("inserts, reads, updates and deletes a destination; timestamps are ISO and the actor is kept", async () => {
    const store = ctx.store();
    const created = await store.insertDataDestination({ ...write(), id: "d1", actor: "admin@example.com" });
    expect(created).toMatchObject({ id: "d1", name: "Model", kind: "model_provider", targetId: null, host: "api.example.com", tier: "vendor", region: "eu", holdsDataClasses: ["email"], note: null, builtIn: false, createdBy: "admin@example.com", updatedBy: "admin@example.com" });
    expect(created.createdAt).toMatch(ISO);
    expect(await store.getDataDestination("d1")).toEqual(created);
    const updated = await store.updateDataDestination("d1", { ...write({ name: "Renamed", tier: "private", holdsDataClasses: [], note: "n" }), actor: null, at: "2026-11-01T00:00:00.000Z" });
    expect(updated).toMatchObject({ name: "Renamed", tier: "private", holdsDataClasses: [], note: "n", updatedBy: null, updatedAt: "2026-11-01T00:00:00.000Z", createdAt: created.createdAt, createdBy: "admin@example.com" });
    expect(await store.updateDataDestination("missing", { ...write(), actor: null })).toBeNull();
    expect(await store.deleteDataDestination("d1")).toBe(true);
    expect(await store.deleteDataDestination("d1")).toBe(false);
    expect(await store.getDataDestination("d1")).toBeNull();
  });

  it("lists by tier, name, id (binary order); finds by exact match with null target or host", async () => {
    const store = ctx.store();
    await store.insertDataDestination({ ...write({ name: "b", tier: "vendor", host: "b.example.com" }), id: "d3", actor: null });
    await store.insertDataDestination({ ...write({ name: "B", tier: "vendor", host: "c.example.com" }), id: "d2", actor: null });
    await store.insertDataDestination({ ...write({ name: "z", tier: "private", kind: "mcp_server", targetId: "srv", host: null }), id: "d1", actor: null });
    expect((await store.listDataDestinations()).map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect((await store.findDataDestinationByMatch("mcp_server", "srv", null))?.id).toBe("d1");
    expect(await store.findDataDestinationByMatch("mcp_server", "srv", "x")).toBeNull();
    expect((await store.findDataDestinationByMatch("model_provider", null, "c.example.com"))?.id).toBe("d2");
    await expect(store.insertDataDestination({ ...write({ name: "dup", tier: "vendor", host: "c.example.com" }), id: "d9", actor: null })).rejects.toThrow();
  });

  it("lists every workflow's draft JSON, newest change first", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-a", "A"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.upsertWorkflow(workflow("wf-b", "B"));
    const configs = await store.listWorkflowConfigsForDestinations();
    expect(configs.map((c) => [c.id, c.name, c.publishedJson])).toEqual([["wf-b", "B", null], ["wf-a", "A", null]]);
    expect(JSON.parse(configs[0]!.draftJson)).toMatchObject({ id: "wf-b" });
  });

  it("a published workflow also gives its published version's JSON", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-a", "Draft name"));
    const saved = await store.appendWorkflowVersion({ id: "ver-1", workflowId: "wf-a", workflowJson: JSON.stringify({ id: "wf-a", published: true }), retention: 10 });
    const release = await store.publishWorkflowVersion(
      { id: "rel-1", workflowId: "wf-a", version: saved.version, workflowHash: "h", replayRunId: null, verdict: "ungated", reason: null, gateReasons: [], approval: null, publishedAt: new Date().toISOString(), publishedBy: "a", publishedByUserId: null },
      null
    );
    expect(release).not.toBeNull();
    const [config] = await store.listWorkflowConfigsForDestinations();
    expect(config).toMatchObject({ id: "wf-a", name: "Draft name" });
    expect(JSON.parse(config!.publishedJson!)).toEqual({ id: "wf-a", published: true });
  });
});
