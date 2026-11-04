/**
 * Roadmap 7.3 — optional pagination on list endpoints. Without `page` / `pageSize` every route answers exactly as
 * before; with either it answers `{ items, total, page, pageSize }` (plus the route's non-list fields). Runs on SQLite
 * and, under TEST_STORE=postgres, on Postgres.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  callAs,
  closeReleaseTestContext,
  createReleaseTestContext,
  hookWorkflow,
  loginAs,
  type ReleaseTestContext
} from "./test-support/release.test-helper.js";

const contexts: ReleaseTestContext[] = [];

async function context(env?: Record<string, string>): Promise<ReleaseTestContext> {
  const created = await createReleaseTestContext(env ? { env } : {});
  contexts.push(created);
  return created;
}

afterEach(async () => {
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

interface Envelope<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

async function seedWorkflows(ctx: ReleaseTestContext, count: number, projectId = "default", prefix = "wf") {
  for (let index = 0; index < count; index += 1) {
    const workflow = hookWorkflow(`${prefix}-${index}`, "ok", projectId);
    await ctx.store.upsertWorkflow({ ...workflow, tags: index % 2 === 0 ? ["Even"] : ["odd"] });
  }
}

describe("GET /api/workflows", () => {
  it("answers the plain array without page params and the envelope with them", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    await seedWorkflows(ctx, 5);

    const plain = await callAs(ctx, "GET", "/api/workflows", admin.cookie);
    expect(plain.statusCode).toBe(200);
    const all = plain.json<Array<{ id: string }>>();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toHaveLength(5);

    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const response = await callAs(ctx, "GET", `/api/workflows?page=${page}&pageSize=2`, admin.cookie);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<Envelope<{ id: string }>>();
      expect(body).toMatchObject({ total: 5, page, pageSize: 2 });
      expect(body.items.length).toBe(page === 3 ? 1 : 2);
      seen.push(...body.items.map((item) => item.id));
    }
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual(all.map((item) => item.id).sort());
  });

  it("applies the filters before the page is cut, the tag filter included", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    await seedWorkflows(ctx, 5);
    const tagged = (await callAs(ctx, "GET", "/api/workflows?tag=even&pageSize=2", admin.cookie)).json<Envelope<{ id: string; tags: string[] }>>();
    expect(tagged.total).toBe(3);
    expect(tagged.items).toHaveLength(2);
    for (const item of tagged.items) expect(item.tags).toEqual(["Even"]);
    const searched = (await callAs(ctx, "GET", "/api/workflows?search=wf-4&page=1", admin.cookie)).json<Envelope<{ id: string }>>();
    expect(searched).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(searched.items.map((item) => item.id)).toEqual(["wf-4"]);
  });

  it("only counts and lists workflows the user can read", async () => {
    const ctx = await context({ PROJECT_ISOLATION: "strict" });
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    expect((await callAs(ctx, "POST", "/api/projects", admin.cookie, { id: "proj-a", name: "A" })).statusCode).toBe(200);
    expect((await callAs(ctx, "POST", "/api/projects", admin.cookie, { id: "proj-b", name: "B" })).statusCode).toBe(200);
    await seedWorkflows(ctx, 3, "proj-a", "a");
    await seedWorkflows(ctx, 4, "proj-b", "b");
    const member = await callAs(ctx, "POST", "/api/projects/proj-a/members", admin.cookie, { userId: builder.id, role: "editor" });
    expect(member.statusCode, member.body).toBe(200);

    const plain = (await callAs(ctx, "GET", "/api/workflows", builder.cookie)).json<Array<{ id: string }>>();
    const paged = (await callAs(ctx, "GET", "/api/workflows?pageSize=100", builder.cookie)).json<Envelope<{ id: string }>>();
    expect(plain).toHaveLength(3);
    expect(paged.total).toBe(3);
    expect(paged.items.map((item) => item.id).sort()).toEqual(plain.map((item) => item.id).sort());
    expect(paged.items.every((item) => item.id.startsWith("a-"))).toBe(true);
  });

  it("refuses a malformed page and caps pageSize at 100", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const bad = await callAs(ctx, "GET", "/api/workflows?page=0", admin.cookie);
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe("page must be a positive integer");
    expect((await callAs(ctx, "GET", "/api/workflows?pageSize=abc", admin.cookie)).statusCode).toBe(400);
    const capped = (await callAs(ctx, "GET", "/api/workflows?pageSize=5000", admin.cookie)).json<Envelope<unknown>>();
    expect(capped.pageSize).toBe(100);
  });

  it("checks the session before the query", async () => {
    const ctx = await context();
    const response = await ctx.app.inject({ method: "GET", url: "/api/workflows?page=abc" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/users", () => {
  it("pages in SQL with an unchanged plain answer", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    for (const name of ["u1", "u2", "u3", "u4"]) await loginAs(ctx, "viewer", name);
    const plain = (await callAs(ctx, "GET", "/api/users", admin.cookie)).json<{ users: Array<{ id: string; email: string; role: string; createdAt: string }> }>();
    expect(plain.users).toHaveLength(5);
    expect(Object.keys(plain.users[0]!).sort()).toEqual(["createdAt", "email", "id", "role"]);
    const first = (await callAs(ctx, "GET", "/api/users?pageSize=3", admin.cookie)).json<Envelope<{ id: string }>>();
    const second = (await callAs(ctx, "GET", "/api/users?pageSize=3&page=2", admin.cookie)).json<Envelope<{ id: string }>>();
    expect(first).toMatchObject({ total: 5, page: 1, pageSize: 3 });
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(5);
  });
});

describe("configuration lists paged in memory", () => {
  it("projects: equal names are ordered by id", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    for (const id of ["proj-c", "proj-a", "proj-b"]) await ctx.store.upsertProject({ id, name: "Same" });
    const plain = (await callAs(ctx, "GET", "/api/projects", admin.cookie)).json<{ projects: Array<{ id: string }> }>();
    expect(plain.projects.length).toBe(4);
    const paged = (await callAs(ctx, "GET", "/api/projects?pageSize=10", admin.cookie)).json<Envelope<{ id: string; name: string }>>();
    expect(paged.total).toBe(4);
    expect(paged.items.filter((item) => item.name === "Same").map((item) => item.id)).toEqual(["proj-a", "proj-b", "proj-c"]);
  });

  it("tags, MCP servers and variables keep their keyed answer without page params", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    await seedWorkflows(ctx, 2);
    expect((await callAs(ctx, "GET", "/api/tags", admin.cookie)).json()).toEqual({ tags: ["Even", "odd"] });
    expect((await callAs(ctx, "GET", "/api/tags?page=2&pageSize=1", admin.cookie)).json()).toEqual({ items: ["odd"], total: 2, page: 2, pageSize: 1 });

    const servers = (await callAs(ctx, "GET", "/api/mcp/servers", admin.cookie)).json<Record<string, unknown>>();
    expect(Object.keys(servers).sort()).toEqual(["adapters", "defaultProbeIntervalMs", "sandboxPolicy", "servers"]);
    const pagedServers = (await callAs(ctx, "GET", "/api/mcp/servers?page=1", admin.cookie)).json<Record<string, unknown>>();
    expect(pagedServers).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(pagedServers.adapters).toEqual(servers.adapters);

    for (const key of ["B", "A", "C"]) {
      expect((await callAs(ctx, "POST", "/api/variables", admin.cookie, { projectId: "default", key, value: key.toLowerCase() })).statusCode).toBe(200);
    }
    const variables = (await callAs(ctx, "GET", "/api/variables?projectId=default", admin.cookie)).json<{ variables: Array<{ key: string }> }>();
    expect(variables.variables.map((item) => item.key)).toEqual(["A", "B", "C"]);
    const pagedVariables = (await callAs(ctx, "GET", "/api/variables?projectId=default&page=2&pageSize=2", admin.cookie)).json<Envelope<{ key: string }>>();
    expect(pagedVariables).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(pagedVariables.items.map((item) => item.key)).toEqual(["C"]);
  });

  it("secrets stay a plain array; paged after the visibility check", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    for (const name of ["s1", "s2", "s3"]) {
      const created = await callAs(ctx, "POST", "/api/secrets", builder.cookie, { name, provider: "openai", value: `sk-${name}` });
      expect(created.statusCode, created.body).toBe(200);
    }
    const plain = (await callAs(ctx, "GET", "/api/secrets", builder.cookie)).json<unknown[]>();
    expect(Array.isArray(plain)).toBe(true);
    expect(plain).toHaveLength(3);
    const paged = (await callAs(ctx, "GET", "/api/secrets?pageSize=2", builder.cookie)).json<Envelope<{ name: string; value?: string }>>();
    expect(paged).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(JSON.stringify(paged)).not.toContain("sk-s");
  });

  it("templates page in the gallery's order and enrich only the page", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const plain = (await callAs(ctx, "GET", "/api/templates", admin.cookie)).json<{ templates: Array<{ id: string }> }>();
    const paged = (await callAs(ctx, "GET", `/api/templates?pageSize=100`, admin.cookie)).json<Envelope<{ id: string; dependencies: unknown }>>();
    expect(paged.total).toBe(plain.templates.length);
    expect(paged.items.map((item) => item.id)).toEqual(plain.templates.map((item) => item.id));
  });
});
