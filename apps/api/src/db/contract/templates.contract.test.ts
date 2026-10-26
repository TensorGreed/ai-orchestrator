/**
 * Phase 13.1 — store contract: workflow templates. The first contract file; it proves the harness (the same
 * assertions on SQLite and, with TEST_POSTGRES_URL, on Postgres) and covers migration v11 on Postgres.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function template(id: string, overrides: Partial<{ name: string; description: string; category: string; tags: string[] }> = {}) {
  return {
    id,
    name: overrides.name ?? `Template ${id}`,
    description: overrides.description ?? "",
    category: overrides.category ?? "General",
    tags: overrides.tags ?? [],
    author: "contract-test",
    workflowJson: JSON.stringify({ id, nodes: [], edges: [] }),
    nodeCount: 0
  };
}

describeStoreContract("store contract: workflow templates", (ctx) => {
  it("upserts, reads back and counts a template; timestamps are ISO strings", async () => {
    const store = ctx.store();
    expect(await store.countTemplates()).toBe(0);
    await store.upsertTemplate({ ...template("tpl-a", { tags: ["rag", "demo"] }), nodeCount: 3 });
    const got = await store.getTemplate("tpl-a");
    expect(got).toMatchObject({ id: "tpl-a", name: "Template tpl-a", category: "General", tags: ["rag", "demo"], author: "contract-test", nodeCount: 3 });
    expect(got?.workflowJson).toBe(JSON.stringify({ id: "tpl-a", nodes: [], edges: [] }));
    expect(got?.createdAt).toMatch(ISO);
    expect(got?.updatedAt).toMatch(ISO);
    expect(await store.countTemplates()).toBe(1);
    expect(await store.getTemplate("missing")).toBeUndefined();
  });

  it("an upsert of an existing id updates it and keeps its creation time", async () => {
    const store = ctx.store();
    await store.upsertTemplate(template("tpl-a"));
    const first = await store.getTemplate("tpl-a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.upsertTemplate(template("tpl-a", { name: "Renamed", category: "Ops" }));
    const second = await store.getTemplate("tpl-a");
    expect(second).toMatchObject({ name: "Renamed", category: "Ops" });
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(Date.parse(second!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first!.updatedAt));
    expect(await store.countTemplates()).toBe(1);
  });

  it("lists by category then name, filters by category and by search", async () => {
    const store = ctx.store();
    await store.upsertTemplate(template("t1", { name: "Zeta", category: "B" }));
    await store.upsertTemplate(template("t2", { name: "Alpha", category: "B", description: "Summarise tickets" }));
    await store.upsertTemplate(template("t3", { name: "Mid", category: "A" }));
    expect((await store.listTemplates()).map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
    expect((await store.listTemplates({ category: "B" })).map((t) => t.id)).toEqual(["t2", "t1"]);
    expect((await store.listTemplates({ search: "TICKETS" })).map((t) => t.id)).toEqual(["t2"]);
  });

  it("deletes a template once", async () => {
    const store = ctx.store();
    await store.upsertTemplate(template("tpl-a"));
    expect(await store.deleteTemplate("tpl-a")).toBe(true);
    expect(await store.deleteTemplate("tpl-a")).toBe(false);
    expect(await store.countTemplates()).toBe(0);
  });

  it("each test gets its own empty store", async () => {
    expect(await ctx.store().countTemplates()).toBe(0);
  });
});
