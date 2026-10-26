/**
 * Phase 13.1 — store contract: audit log (hash chain, filters, export cursor), log streaming, audit export
 * destinations and runs, execution manifests and audit signing keys. Same assertions on SQLite and, with
 * TEST_POSTGRES_URL, on Postgres. The concurrency cases at the end race on Postgres (a pool of 4); SQLite runs them
 * one after another.
 */
import { expect, it } from "vitest";
import type { Store } from "../store.js";
import { describeStoreContract } from "../../test-support/test-store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function entry(id: string, overrides: Partial<Parameters<Store["writeAuditLog"]>[0]> = {}): Parameters<Store["writeAuditLog"]>[0] {
  return { id, eventType: "auth.login", category: "auth", action: "login", outcome: "success", ...overrides };
}

const pause = (ms = 3) => new Promise((resolve) => setTimeout(resolve, ms));

describeStoreContract("store contract: audit", (ctx) => {
  it("writes entries, lists them newest first with defaults, parsed metadata and ISO times", async () => {
    const store = ctx.store();
    await store.writeAuditLog(entry("a1", { metadata: { executionId: "x", n: 1 }, actorUserId: "u1", actorEmail: "u1@example.com", message: "hello" }));
    await pause();
    await store.writeAuditLog(entry("a2", { category: "workflow", eventType: "workflow.saved", outcome: "failure", actorType: "api_key", resourceType: "workflow", resourceId: "wf-1", projectId: "p1", ipAddress: "10.0.0.1", userAgent: "ua" }));
    const page = await store.listAuditLogs();
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(page.items.map((item) => item.id)).toEqual(["a2", "a1"]);
    expect(page.items[1]).toEqual({
      id: "a1",
      eventType: "auth.login",
      category: "auth",
      action: "login",
      outcome: "success",
      actorUserId: "u1",
      actorEmail: "u1@example.com",
      actorType: "user",
      resourceType: null,
      resourceId: null,
      projectId: null,
      ipAddress: null,
      userAgent: null,
      metadata: { executionId: "x", n: 1 },
      message: "hello",
      createdAt: expect.stringMatching(ISO)
    });
    expect(page.items[0]).toMatchObject({ actorType: "api_key", resourceType: "workflow", resourceId: "wf-1", projectId: "p1", ipAddress: "10.0.0.1", userAgent: "ua", metadata: null, message: null });
  });

  it("filters, paginates and clamps the page size", async () => {
    const store = ctx.store();
    for (let i = 0; i < 5; i += 1) {
      await store.writeAuditLog(entry(`e${i}`, { category: i % 2 ? "auth" : "workflow", outcome: i === 4 ? "denied" : "success", actorUserId: i < 2 ? "u1" : "u2", createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }));
    }
    expect((await store.listAuditLogs({ category: "auth" })).items.map((item) => item.id)).toEqual(["e3", "e1"]);
    expect((await store.listAuditLogs({ outcome: "denied" })).total).toBe(1);
    expect((await store.listAuditLogs({ actorUserId: "u1" })).items.map((item) => item.id)).toEqual(["e1", "e0"]);
    expect((await store.listAuditLogs({ from: "2026-01-02T00:00:00.000Z", to: "2026-01-04T00:00:00.000Z" })).items.map((item) => item.id)).toEqual(["e3", "e2", "e1"]);
    const second = await store.listAuditLogs({ page: 2, pageSize: 2 });
    expect(second).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(second.items.map((item) => item.id)).toEqual(["e2", "e1"]);
    expect(await store.listAuditLogs({ page: 0, pageSize: 10_000 })).toMatchObject({ page: 1, pageSize: 500 });
    expect((await store.listAuditLogs({ pageSize: 0 })).pageSize).toBe(1);
    expect((await store.listAuditLogs({ resourceType: "nothing" })).items).toEqual([]);
  });

  it("keeps a verifiable hash chain and the export cursor walks it in insertion order", async () => {
    const store = ctx.store();
    expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 0 });
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    for (const id of ids) await store.writeAuditLog(entry(id, { metadata: { id } }));
    expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 5 });

    const all = await store.listAuditLogsAfter({ afterId: null, limit: 100 });
    expect(all.map((row) => row.id)).toEqual(ids);
    expect(all.every((row) => /^[0-9a-f]{64}$/.test(row.entryHash ?? ""))).toBe(true);
    expect(new Set(all.map((row) => row.entryHash)).size).toBe(5);
    expect(all[0]).toMatchObject({ metadata: { id: "c1" }, createdAt: expect.stringMatching(ISO) });

    expect((await store.listAuditLogsAfter({ afterId: "c2", limit: 2 })).map((row) => row.id)).toEqual(["c3", "c4"]);
    expect((await store.listAuditLogsAfter({ afterId: "c5", limit: 2 })).map((row) => row.id)).toEqual([]);
    // A cursor that no longer exists starts again from the beginning.
    expect((await store.listAuditLogsAfter({ afterId: "gone", limit: 2 })).map((row) => row.id)).toEqual(["c1", "c2"]);
    expect((await store.listAuditLogsAfter({ afterId: null, limit: 0 })).length).toBe(1);
  });

  it("prunes audit entries older than the cut-off and manifests whose history is gone", async () => {
    const store = ctx.store();
    await store.writeAuditLog(entry("old", { createdAt: "2001-01-01T00:00:00.000Z" }));
    await store.writeAuditLog(entry("new"));
    await store.saveExecutionRunContext("exec-gone", { a: 1 }, "2001-01-01T00:00:00.000Z");
    await store.saveExecutionRunContext("exec-kept", { a: 2 }, "2001-01-01T00:00:00.000Z");
    await store.saveExecutionHistory({ id: "exec-kept", workflowId: "wf", status: "success", startedAt: "2001-01-01T00:00:00.000Z" });
    expect(await store.pruneAuditLogs({ before: "2020-01-01T00:00:00.000Z" })).toBe(1);
    expect(await store.pruneAuditLogs({ before: "2020-01-01T00:00:00.000Z" })).toBe(0);
    expect((await store.listAuditLogs()).items.map((item) => item.id)).toEqual(["new"]);
    expect(await store.getExecutionManifest("exec-gone")).toBeNull();
    expect(await store.getExecutionManifest("exec-kept")).not.toBeNull();
    await store.saveExecutionRunContext("exec-gone-2", {}, "2001-01-01T00:00:00.000Z");
    expect(await store.pruneExecutionManifests({ before: "2000-01-01T00:00:00.000Z" })).toBe(0);
    expect(await store.pruneExecutionManifests({ before: "2020-01-01T00:00:00.000Z" })).toBe(1);
  });

  it("a far-future row does not move later rows' times: prune and from/to still place them by their own time", async () => {
    const store = ctx.store();
    await store.writeAuditLog(entry("future", { createdAt: "2099-01-01T00:00:00.000Z" }));
    const before = Date.now();
    for (const id of ["n1", "n2", "n3"]) {
      await store.writeAuditLog(entry(id));
      await pause();
    }
    const after = Date.now();
    const items = (await store.listAuditLogs()).items;
    expect(items.map((item) => item.id)).toEqual(["future", "n3", "n2", "n1"]);
    for (const item of items.slice(1)) {
      expect(Date.parse(item.createdAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(item.createdAt)).toBeLessThanOrEqual(after);
    }
    // The chain is in insertion order, so the future-dated first row is not reported.
    expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 4 });
    expect((await store.listAuditLogsAfter({ afterId: "future", limit: 10 })).map((row) => row.id)).toEqual(["n1", "n2", "n3"]);
    const nextYear = new Date(after + 365 * 24 * 3600 * 1000).toISOString();
    expect((await store.listAuditLogs({ from: nextYear })).items.map((item) => item.id)).toEqual(["future"]);
    expect((await store.listAuditLogs({ to: nextYear })).items.map((item) => item.id)).toEqual(["n3", "n2", "n1"]);
    expect(await store.pruneAuditLogs({ before: nextYear })).toBe(3);
    expect((await store.listAuditLogs()).items.map((item) => item.id)).toEqual(["future"]);
    // The next write links to the newest remaining row, the future one, and gets its own time.
    await store.writeAuditLog(entry("n4"));
    expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 2 });
    expect(Date.parse((await store.listAuditLogs()).items[1]!.createdAt)).toBeLessThan(Date.parse("2099-01-01T00:00:00.000Z") - 1000);
  });

  it("log stream destinations: upsert keeps history and creator, dispatches count, delete removes events once", async () => {
    const store = ctx.store();
    expect(await store.getLogStreamDestination("d1")).toBeNull();
    await store.upsertLogStreamDestination({ id: "d1", name: "Splunk", type: "http", categories: ["auth", "workflow"], configIv: "iv", configAuthTag: "tag", configCiphertext: "ct", createdBy: "u1" });
    await pause();
    await store.upsertLogStreamDestination({ id: "d2", name: "File", type: "file", enabled: false });
    const d1 = await store.getLogStreamDestination("d1");
    expect(d1).toEqual({
      id: "d1",
      name: "Splunk",
      type: "http",
      enabled: true,
      categories: ["auth", "workflow"],
      minLevel: "info",
      configIv: "iv",
      configAuthTag: "tag",
      configCiphertext: "ct",
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      dispatchedCount: 0,
      failedCount: 0,
      createdBy: "u1",
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO)
    });
    expect((await store.listLogStreamDestinations()).map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(await store.getLogStreamDestination("d2")).toMatchObject({ enabled: false, categories: [], createdBy: null, configIv: null });

    await store.recordLogStreamDispatch({ destinationId: "d1", success: true, at: "2026-02-01T00:00:00.000Z" });
    await store.recordLogStreamDispatch({ destinationId: "d1", success: true });
    await store.recordLogStreamDispatch({ destinationId: "d1", success: false, at: "2026-02-02T00:00:00.000Z" });
    await store.recordLogStreamDispatch({ destinationId: "d1", success: false, error: "boom", at: "2026-02-03T00:00:00.000Z" });
    await pause();
    await store.upsertLogStreamDestination({ id: "d1", name: "Splunk 2", type: "http", minLevel: "warn", createdBy: "someone-else" });
    const after = await store.getLogStreamDestination("d1");
    expect(after).toMatchObject({
      name: "Splunk 2",
      minLevel: "warn",
      categories: [],
      configIv: null,
      dispatchedCount: 2,
      failedCount: 2,
      lastErrorAt: "2026-02-03T00:00:00.000Z",
      lastError: "boom",
      createdBy: "u1",
      createdAt: d1!.createdAt
    });
    expect(after!.lastSuccessAt).toMatch(ISO);

    await store.writeLogStreamEvent({ id: "ev1", destinationId: "d1", category: "auth", eventType: "auth.login", level: "info", status: "sent" });
    await store.writeLogStreamEvent({ id: "ev2", destinationId: "d2", category: "auth", eventType: "auth.login", level: "info", status: "sent" });
    expect(await store.deleteLogStreamDestination("d1")).toBe(true);
    expect(await store.deleteLogStreamDestination("d1")).toBe(false);
    expect((await store.listLogStreamEvents()).map((e) => e.id)).toEqual(["ev2"]);
  });

  it("log stream events: list filters, orders newest first, clamps the limit and prunes", async () => {
    const store = ctx.store();
    await store.writeLogStreamEvent({ id: "e1", destinationId: "d1", category: "auth", eventType: "auth.login", level: "info", status: "sent", createdAt: "2026-01-01T00:00:00.000Z", payload: { a: [1, 2] } });
    await store.writeLogStreamEvent({ id: "e2", destinationId: "d1", category: "workflow", eventType: "workflow.run", level: "warn", status: "failed", attempts: 3, error: "timeout", createdAt: "2026-01-02T00:00:00.000Z" });
    await store.writeLogStreamEvent({ id: "e3", destinationId: "d2", category: "auth", eventType: "auth.logout", level: "info", status: "pending", createdAt: "2026-01-03T00:00:00.000Z" });
    expect((await store.listLogStreamEvents()).map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect((await store.listLogStreamEvents({ destinationId: "d1" })).map((e) => e.id)).toEqual(["e2", "e1"]);
    expect((await store.listLogStreamEvents({ status: "failed" }))[0]).toEqual({
      id: "e2",
      destinationId: "d1",
      category: "workflow",
      eventType: "workflow.run",
      level: "warn",
      status: "failed",
      attempts: 3,
      error: "timeout",
      payload: null,
      createdAt: "2026-01-02T00:00:00.000Z"
    });
    expect((await store.listLogStreamEvents({ destinationId: "d1", status: "sent" }))[0]).toMatchObject({ id: "e1", attempts: 0, error: null, payload: { a: [1, 2] } });
    expect((await store.listLogStreamEvents({ limit: 0 })).map((e) => e.id)).toEqual(["e3"]);
    expect(await store.pruneLogStreamEvents({ before: "2026-01-03T00:00:00.000Z" })).toBe(2);
    expect(await store.pruneLogStreamEvents({ before: "2026-01-03T00:00:00.000Z" })).toBe(0);
    expect((await store.listLogStreamEvents()).map((e) => e.id)).toEqual(["e3"]);
  });

  it("audit export destinations and runs", async () => {
    const store = ctx.store();
    await store.createAuditExportDestination({ id: "x1", name: "alpha", kind: "http", config: { url: "https://example.com" }, createdBy: "u1" });
    await store.createAuditExportDestination({ id: "x2", name: "Zeta", kind: "file", config: { path: "/tmp/a" }, intervalSeconds: 60, enabled: false });
    await store.createAuditExportDestination({ id: "x3", name: "Beta", kind: "file", config: {} });
    // Binary (code point) order: upper case before lower case.
    expect((await store.listAuditExportDestinations()).map((d) => d.name)).toEqual(["Beta", "Zeta", "alpha"]);
    expect(await store.getAuditExportDestination("x1")).toEqual({
      id: "x1",
      name: "alpha",
      kind: "http",
      config: { url: "https://example.com" },
      intervalSeconds: 3600,
      enabled: true,
      lastExportId: null,
      lastExportAt: null,
      lastStatus: null,
      lastError: null,
      createdBy: "u1",
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO)
    });
    expect(await store.getAuditExportDestination("x2")).toMatchObject({ intervalSeconds: 60, enabled: false, createdBy: null });
    expect(await store.getAuditExportDestination("nope")).toBeNull();

    expect(await store.updateAuditExportDestination("x2", {})).toBe(false);
    expect(await store.updateAuditExportDestination("x2", { name: "Zed", config: { path: "/b" }, intervalSeconds: 120, enabled: true })).toBe(true);
    expect(await store.getAuditExportDestination("x2")).toMatchObject({ name: "Zed", config: { path: "/b" }, intervalSeconds: 120, enabled: true });
    expect(await store.updateAuditExportDestination("missing", { name: "n" })).toBe(true);

    await store.recordAuditExportRun({ id: "r1", destinationId: "x1", startedAt: "2026-03-01T00:00:00.000Z", completedAt: "2026-03-01T00:00:01.000Z", status: "success", rowsExported: 10, firstId: "a", lastId: "b" });
    expect(await store.getAuditExportDestination("x1")).toMatchObject({ lastExportId: "b", lastExportAt: "2026-03-01T00:00:01.000Z", lastStatus: "success", lastError: null });
    await store.recordAuditExportRun({ id: "r2", destinationId: "x1", startedAt: "2026-03-02T00:00:00.000Z", completedAt: "2026-03-02T00:00:01.000Z", status: "failure", rowsExported: 0 });
    expect(await store.getAuditExportDestination("x1")).toMatchObject({ lastExportId: "b", lastStatus: "failure", lastError: "unknown" });
    await store.recordAuditExportRun({ id: "r3", destinationId: "x1", startedAt: "2026-03-03T00:00:00.000Z", completedAt: "2026-03-03T00:00:01.000Z", status: "partial", rowsExported: 2, error: "half" });
    expect(await store.getAuditExportDestination("x1")).toMatchObject({ lastStatus: "failure", lastError: "unknown" });

    const runs = await store.listAuditExportRuns("x1");
    expect(runs.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect(runs[2]).toEqual({ id: "r1", destinationId: "x1", startedAt: "2026-03-01T00:00:00.000Z", completedAt: "2026-03-01T00:00:01.000Z", status: "success", rowsExported: 10, firstId: "a", lastId: "b", error: null });
    expect(runs[0]).toMatchObject({ firstId: null, lastId: null, error: "half" });
    expect((await store.listAuditExportRuns("x1", 0)).map((r) => r.id)).toEqual(["r3"]);

    expect(await store.deleteAuditExportDestination("x1")).toBe(true);
    expect(await store.deleteAuditExportDestination("x1")).toBe(true);
    expect(await store.getAuditExportDestination("x1")).toBeNull();
    expect(await store.listAuditExportRuns("x1")).toEqual([]);
  });

  it("execution manifests: the run context is replaceable until the manifest exists, which is stored once", async () => {
    const store = ctx.store();
    expect(await store.getExecutionManifest("e1")).toBeNull();
    await store.saveExecutionRunContext("e1", { v: 1 }, "2026-04-01T00:00:00.000Z");
    await store.saveExecutionRunContext("e1", { v: 2 }, "2026-04-02T00:00:00.000Z");
    expect(await store.getExecutionManifest("e1")).toEqual({
      executionId: "e1",
      runContext: { v: 2 },
      manifestJson: null,
      manifestDigest: null,
      keyId: null,
      signature: null,
      signedAt: null,
      createdAt: "2026-04-02T00:00:00.000Z"
    });
    const first = await store.saveExecutionManifest({ executionId: "e1", manifestJson: "{\"a\":1}", manifestDigest: "d1", keyId: "k1", signature: "s1", signedAt: "2026-04-03T00:00:00.000Z" });
    expect(first).toEqual({ executionId: "e1", runContext: { v: 2 }, manifestJson: "{\"a\":1}", manifestDigest: "d1", keyId: "k1", signature: "s1", signedAt: "2026-04-03T00:00:00.000Z", createdAt: "2026-04-02T00:00:00.000Z" });
    const second = await store.saveExecutionManifest({ executionId: "e1", manifestJson: "{\"a\":2}", manifestDigest: "d2", keyId: "k2", signature: "s2", signedAt: "2026-04-04T00:00:00.000Z" });
    expect(second).toEqual(first);
    await store.saveExecutionRunContext("e1", { v: 3 }, "2026-04-05T00:00:00.000Z");
    expect(await store.getExecutionManifest("e1")).toEqual(first);
    // A manifest with no run context recorded first: created at its signing time.
    expect(await store.saveExecutionManifest({ executionId: "e2", manifestJson: "{}", manifestDigest: "d", keyId: "k", signature: "s", signedAt: "2026-04-06T00:00:00.000Z" })).toMatchObject({ runContext: null, createdAt: "2026-04-06T00:00:00.000Z" });
  });

  it("lists an execution's audit entries by resource or metadata executionId, oldest first, with the actor's role", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "builder" });
    await store.writeAuditLog(entry("m2", { createdAt: "2026-05-02T00:00:00.000Z", metadata: { executionId: "exec-1" }, actorUserId: "u1", message: "meta" }));
    await store.writeAuditLog(entry("m1", { createdAt: "2026-05-01T00:00:00.000Z", resourceType: "execution", resourceId: "exec-1", actorType: "system" }));
    await store.writeAuditLog(entry("m3", { createdAt: "2026-05-03T00:00:00.000Z", metadata: { other: "exec-1" } }));
    await store.writeAuditLog(entry("m4", { createdAt: "2026-05-04T00:00:00.000Z", resourceType: "workflow", resourceId: "exec-1" }));
    await store.writeAuditLog(entry("m5", { createdAt: "2026-05-05T00:00:00.000Z", metadata: { executionId: "exec-10" } }));
    const rows = await store.listAuditLogsForExecution("exec-1");
    expect(rows).toEqual([
      { eventType: "auth.login", action: "login", outcome: "success", actorUserId: null, actorRole: null, actorEmail: null, actorType: "system", message: null, createdAt: "2026-05-01T00:00:00.000Z" },
      { eventType: "auth.login", action: "login", outcome: "success", actorUserId: "u1", actorRole: "builder", actorEmail: null, actorType: "user", message: "meta", createdAt: "2026-05-02T00:00:00.000Z" }
    ]);
    expect(await store.listAuditLogsForExecution("none")).toEqual([]);
  });

  it("signing keys: activation is compare-and-set, retires the previous key and can re-activate an old one", async () => {
    const store = ctx.store();
    expect(await store.getActiveAuditSigningKey()).toBeNull();
    expect(await store.listAuditSigningKeys()).toEqual([]);
    const keyA = { keyId: "kA", algorithm: "Ed25519", publicKey: "pa", source: "generated" as const, secretId: "sec-a", createdAt: "2026-06-01T00:00:00.000Z" };
    const keyB = { keyId: "kB", algorithm: "Ed25519", publicKey: "pb", source: "env" as const, secretId: null, createdAt: "2026-06-02T00:00:00.000Z" };
    expect(await store.activateAuditSigningKey(keyA, null)).toBe(true);
    expect(await store.activateAuditSigningKey(keyB, null)).toBe(false);
    expect(await store.getActiveAuditSigningKey()).toEqual({ ...keyA, status: "active", retiredAt: null });
    expect(await store.activateAuditSigningKey(keyB, "kA")).toBe(true);
    expect(await store.getAuditSigningKey("kA")).toEqual({ ...keyA, secretId: null, status: "retired", retiredAt: expect.stringMatching(ISO) });
    expect((await store.getActiveAuditSigningKey())?.keyId).toBe("kB");
    expect((await store.listAuditSigningKeys()).map((k) => `${k.keyId}:${k.status}`)).toEqual(["kB:active", "kA:retired"]);
    // Putting an old key back re-activates its row (keeping its creation time).
    expect(await store.activateAuditSigningKey({ ...keyA, createdAt: "2030-01-01T00:00:00.000Z", secretId: "sec-a2" }, "kB")).toBe(true);
    expect(await store.getAuditSigningKey("kA")).toEqual({ ...keyA, secretId: "sec-a2", status: "active", retiredAt: null });
    expect((await store.getAuditSigningKey("kB"))?.status).toBe("retired");
    // Activating the active key again is a no-op success.
    expect(await store.activateAuditSigningKey(keyA, "kA")).toBe(true);
    expect(await store.getAuditSigningKey("missing")).toBeNull();
  });

  it("orders signing keys of one creation time by key id in binary order", async () => {
    const store = ctx.store();
    const base = { algorithm: "Ed25519", publicKey: "p", source: "generated" as const, secretId: null, createdAt: "2026-06-01T00:00:00.000Z" };
    expect(await store.activateAuditSigningKey({ ...base, keyId: "b" }, null)).toBe(true);
    expect(await store.activateAuditSigningKey({ ...base, keyId: "B" }, "b")).toBe(true);
    expect(await store.activateAuditSigningKey({ ...base, keyId: "a" }, "B")).toBe(true);
    expect((await store.listAuditSigningKeys()).map((k) => k.keyId)).toEqual(["B", "a", "b"]);
  });

  it("50 concurrent audit writes keep one chain: a valid chain, a cursor walk that sees each row once", async () => {
      const store = ctx.store();
      const ids = Array.from({ length: 50 }, (_, i) => `race-${String(i).padStart(2, "0")}`);
      await Promise.all(ids.map((id) => store.writeAuditLog(entry(id, { metadata: { id } }))));
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 50 });
      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const batch = await store.listAuditLogsAfter({ afterId: cursor, limit: 7 });
        if (batch.length === 0) break;
        seen.push(...batch.map((row) => row.id));
        cursor = batch[batch.length - 1]!.id;
      }
      expect(seen.length).toBe(50);
      expect(new Set(seen)).toEqual(new Set(ids));
      const listed = await store.listAuditLogs({ pageSize: 500 });
      expect(listed.total).toBe(50);
      expect(listed.items.every((item) => ISO.test(item.createdAt))).toBe(true);
      // Postgres breaks same-millisecond ties by insertion order (seq); SQLite's tie order there is its index's.
      if (ctx.kind === "postgres") expect(listed.items.map((item) => item.id).reverse()).toEqual(seen);
      // Writes after the race extend the same chain.
      await store.writeAuditLog(entry("after"));
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 51 });
    }, 60_000);

    it("two signing-key activations racing from the same expected key: exactly one wins", async () => {
      const store = ctx.store();
      const base = { algorithm: "Ed25519", publicKey: "p", source: "generated" as const, secretId: null, createdAt: "2026-06-01T00:00:00.000Z" };
      for (let round = 0; round < 5; round += 1) {
        const expected = (await store.getActiveAuditSigningKey())?.keyId ?? null;
        const results = await Promise.all([
          store.activateAuditSigningKey({ ...base, keyId: `r${round}-x` }, expected),
          store.activateAuditSigningKey({ ...base, keyId: `r${round}-y` }, expected)
        ]);
        expect(results.filter(Boolean).length).toBe(1);
        expect((await store.listAuditSigningKeys()).filter((k) => k.status === "active").length).toBe(1);
      }
    }, 60_000);
});
