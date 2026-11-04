/**
 * 12.6b — store contract: AI gateway route sets, routes, client grants and request rows, and their part in budget
 * usage. The same assertions run on SQLite and, with TEST_POSTGRES_URL, on Postgres.
 */
import { expect, it } from "vitest";
import type { AiGatewayRequestRecord } from "@ai-orchestrator/shared";
import type { Store } from "../store.js";
import { AiGatewayAliasTakenError } from "../ai-gateway-store.js";
import { describeStoreContract } from "../../test-support/test-store.js";

function iso(offsetMs: number): string {
  return new Date(Date.parse("2026-11-04T07:00:00.000Z") + offsetMs).toISOString();
}

function request(id: string, overrides: Partial<AiGatewayRequestRecord> = {}): AiGatewayRequestRecord {
  return {
    id,
    createdAt: iso(0),
    clientId: "cli-1",
    routeSetId: "set-1",
    routeId: "route-1",
    projectId: "p1",
    alias: "fast",
    kind: "chat",
    providerId: "openai",
    model: "gpt-4o-mini",
    stream: false,
    status: "ok",
    httpStatus: 200,
    finishReason: "stop",
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 2,
    totalTokens: 15,
    costUsd: 0.5,
    latencyMs: 120,
    guardOutcome: "none",
    errorCode: null,
    ...overrides
  };
}

async function routeSet(store: Store, id: string, projectId: string | null = "p1", enabled = true) {
  return await store.createAiGatewayRouteSet({ id, name: `Set ${id}`, description: "", projectId, enabled, rateLimit: null, createdBy: "admin" });
}

async function route(store: Store, id: string, routeSetId: string, alias: string, enabled = true) {
  return await store.createAiGatewayRoute({
    id,
    routeSetId,
    alias,
    kind: "chat",
    providerId: "openai",
    model: "gpt-4o-mini",
    baseUrl: null,
    secretId: "sec-1",
    extra: { timeoutMs: 5000 },
    defaults: { temperature: 0.3 },
    enabled,
    createdBy: "admin"
  });
}

describeStoreContract("store contract: AI gateway", (ctx) => {
  it("route sets and routes round-trip; aliases are unique across the deployment", async () => {
    const store = ctx.store();
    const set = await store.createAiGatewayRouteSet({
      id: "set-1",
      name: "Apps",
      description: "For apps",
      projectId: "p1",
      enabled: true,
      rateLimit: { requestsPerMinute: 60, burst: null, maxConcurrent: 4 },
      createdBy: "admin"
    });
    expect(set).toMatchObject({ id: "set-1", name: "Apps", description: "For apps", projectId: "p1", enabled: true, rateLimit: { requestsPerMinute: 60, burst: null, maxConcurrent: 4 } });
    await routeSet(store, "set-2", null);
    const created = await route(store, "route-1", "set-1", "fast");
    expect(created).toMatchObject({ alias: "fast", kind: "chat", secretRef: { secretId: "sec-1" }, extra: { timeoutMs: 5000 }, defaults: { temperature: 0.3 }, enabled: true, baseUrl: null });
    await expect(route(store, "route-2", "set-2", "fast")).rejects.toBeInstanceOf(AiGatewayAliasTakenError);
    await route(store, "route-2", "set-2", "Fast");
    await route(store, "route-3", "set-1", "big");
    expect((await store.listAiGatewayRoutes("set-1")).map((entry) => entry.alias)).toEqual(["big", "fast"]);
    expect((await store.listAiGatewayRoutes()).map((entry) => entry.alias)).toEqual(["Fast", "big", "fast"]);
    await expect(store.updateAiGatewayRoute("route-3", { alias: "fast" })).rejects.toBeInstanceOf(AiGatewayAliasTakenError);
    const updated = await store.updateAiGatewayRoute("route-3", { alias: "bigger", secretId: null, baseUrl: "https://llm.example/v1", enabled: false });
    expect(updated).toMatchObject({ alias: "bigger", secretRef: null, baseUrl: "https://llm.example/v1", enabled: false });
    expect(await store.updateAiGatewayRoute("missing", { alias: "x" })).toBeNull();
    const patched = await store.updateAiGatewayRouteSet("set-1", { projectId: null, rateLimit: null, enabled: false });
    expect(patched).toMatchObject({ projectId: null, rateLimit: null, enabled: false, name: "Apps" });
    expect((await store.listAiGatewayRouteSets()).map((entry) => entry.id)).toEqual(["set-1", "set-2"]);
    expect(await store.deleteAiGatewayRoute("route-2")).toBe(true);
    expect(await store.deleteAiGatewayRoute("route-2")).toBe(false);
  });

  it("grants decide what a client resolves; disabled routes and sets resolve to nothing; deleting a set clears its grants", async () => {
    const store = ctx.store();
    await routeSet(store, "set-1");
    await routeSet(store, "set-2");
    await routeSet(store, "set-off", "p1", false);
    await route(store, "r1", "set-1", "fast");
    await route(store, "r2", "set-2", "embed");
    await route(store, "r3", "set-1", "off", false);
    await route(store, "r4", "set-off", "hidden");
    expect(await store.setAiGatewayClientGrants("cli-1", ["set-1", "set-off"], "admin")).toEqual(["set-1", "set-off"]);
    expect(await store.resolveAiGatewayRoute("cli-1", "fast")).toMatchObject({ route: { id: "r1" }, routeSet: { id: "set-1" } });
    expect(await store.resolveAiGatewayRoute("cli-1", "embed")).toBeNull();
    expect(await store.resolveAiGatewayRoute("cli-1", "off")).toBeNull();
    expect(await store.resolveAiGatewayRoute("cli-1", "hidden")).toBeNull();
    expect(await store.resolveAiGatewayRoute("cli-2", "fast")).toBeNull();
    expect((await store.listAiGatewayRoutesForClient("cli-1")).map((entry) => entry.route.alias)).toEqual(["fast"]);
    // Replacing the grants keeps those already given (in the order they were first granted).
    expect(await store.setAiGatewayClientGrants("cli-1", ["set-2", "set-1"], "admin")).toEqual(["set-1", "set-2"]);
    expect(await store.listAiGatewayClientGrants("cli-1")).toEqual(["set-1", "set-2"]);
    await store.setAiGatewayClientGrants("cli-2", ["set-2"], null);
    expect(await store.deleteAiGatewayRouteSet("set-2")).toBe(true);
    expect(await store.listAiGatewayClientGrants("cli-1")).toEqual(["set-1"]);
    expect(await store.listAllAiGatewayClientGrants()).toEqual([{ clientId: "cli-1", routeSetId: "set-1" }]);
    expect(await store.getAiGatewayRoute("r2")).toBeNull();
    expect(await store.deleteAiGatewayRouteSet("set-2")).toBe(false);
  });

  it("request rows list newest first and summarise by alias and client", async () => {
    const store = ctx.store();
    await store.insertAiGatewayRequest(request("q1"));
    await store.insertAiGatewayRequest(request("q2", { createdAt: iso(1000), clientId: "cli-2", alias: "big", model: "gpt-4o", status: "upstream_error", httpStatus: 502, costUsd: null, totalTokens: 0, inputTokens: 0, outputTokens: 0 }));
    await store.insertAiGatewayRequest(request("q3", { createdAt: iso(2000), status: "blocked_output", guardOutcome: "block", stream: true, finishReason: "content_filter" }));
    await store.insertAiGatewayRequest(request("q0", { createdAt: iso(-86_400_000) }));
    const rows = await store.listAiGatewayRequests({ from: iso(-1), limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["q3", "q2", "q1"]);
    expect(rows[0]).toMatchObject({ stream: true, status: "blocked_output", guardOutcome: "block", finishReason: "content_filter", cachedInputTokens: 2, createdAt: iso(2000) });
    expect(rows[1]!.costUsd).toBeNull();
    expect((await store.listAiGatewayRequests({ from: iso(-1), clientId: "cli-2", limit: 10 })).map((row) => row.id)).toEqual(["q2"]);
    expect((await store.listAiGatewayRequests({ from: iso(-1), limit: 1 })).map((row) => row.id)).toEqual(["q3"]);
    const summary = await store.summarizeAiGatewayUsage({ from: iso(-1) });
    expect(summary.totals).toMatchObject({ requests: 3, errors: 1, blocked: 1, totalTokens: 30, inputTokens: 20, outputTokens: 10, lastRequestAt: iso(2000) });
    expect(summary.totals.costUsd).toBeCloseTo(1, 6);
    expect(summary.byAlias.map((entry) => [entry.alias, entry.requests])).toEqual([
      ["fast", 2],
      ["big", 1]
    ]);
    expect(summary.byClient.map((entry) => [entry.clientId, entry.requests])).toEqual([
      ["cli-1", 2],
      ["cli-2", 1]
    ]);
    expect((await store.summarizeAiGatewayUsage({ from: iso(-1), routeSetId: "nope" })).totals).toMatchObject({ requests: 0, costUsd: 0, lastRequestAt: null });
  });

  it("budget usage counts /v1 requests for the global, project (through the route set) and client scopes", async () => {
    const store = ctx.store();
    await routeSet(store, "set-1", "p1");
    await store.insertAiGatewayRequest(request("q1", { routeSetId: "set-1", costUsd: 0.5, totalTokens: 15 }));
    await store.insertAiGatewayRequest(request("q2", { routeSetId: "set-1", clientId: "cli-2", costUsd: null, totalTokens: 4 }));
    const window = { from: iso(-1), to: iso(10_000) };
    expect(await store.queryBudgetUsage(window)).toEqual({ costUsd: 0.5, totalTokens: 19 });
    expect(await store.queryBudgetUsage({ ...window, projectId: "p1" })).toEqual({ costUsd: 0.5, totalTokens: 19 });
    expect(await store.queryBudgetUsage({ ...window, projectId: "p2" })).toEqual({ costUsd: 0, totalTokens: 0 });
    expect(await store.queryBudgetUsage({ ...window, clientId: "cli-2" })).toEqual({ costUsd: 0, totalTokens: 4 });
    // A set moved to another project takes its requests along (as a toolset's runs do).
    await store.updateAiGatewayRouteSet("set-1", { projectId: "p2" });
    expect(await store.queryBudgetUsage({ ...window, projectId: "p2" })).toEqual({ costUsd: 0.5, totalTokens: 19 });
    // Workflow and user scopes never count /v1.
    expect(await store.queryBudgetUsage({ ...window, workflowId: "wf-1" })).toEqual({ costUsd: 0, totalTokens: 0 });
  });
});
