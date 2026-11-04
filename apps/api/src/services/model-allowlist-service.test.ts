/**
 * 12.6 — the model allowlist's in-process snapshot: no store read per model call, a read failure keeps the last good
 * copy (fail closed only with none), a local edit applies at once, and another instance's edit within the re-read
 * interval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAllowlistEntry } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import { ModelAllowlistService, ModelAllowlistUnavailableError } from "./model-allowlist-service.js";

function entry(partial: Partial<ModelAllowlistEntry>): ModelAllowlistEntry {
  return { id: `mal_${Math.random()}`, scope: "deployment", projectId: null, providerId: "echo", modelGlob: "ok", note: null, createdAt: "2026-11-02T00:00:00.000Z", createdBy: null, ...partial };
}

/** A store holding `rows` (shared, as another instance would write them); `fail` makes reads reject. */
function fakeStore(rows: ModelAllowlistEntry[]) {
  const state = { fail: false };
  const list = vi.fn(async () => {
    if (state.fail) throw new Error("pool timeout");
    return rows.map((row) => ({ ...row }));
  });
  const store = {
    listModelAllowlistEntries: list,
    insertModelAllowlistEntry: vi.fn(async (row: ModelAllowlistEntry) => {
      rows.push(row);
      return { ok: true as const, entry: row };
    }),
    deleteModelAllowlistEntry: vi.fn(async (id: string) => {
      const index = rows.findIndex((row) => row.id === id);
      return index >= 0 ? rows.splice(index, 1)[0]! : null;
    }),
    getProject: vi.fn(async (id: string) => ({ id, name: id }))
  } as unknown as Store;
  return { store, list, state };
}

const call = (model: string) => ({ providerId: "echo", model, operation: "generate" as const, nodeId: "llm" });
const scope = (projectId: string | null = null) => ({ projectId, source: "run" as const });

let services: ModelAllowlistService[] = [];

function service(store: Store, logger = vi.fn()) {
  const created = new ModelAllowlistService(store, { auditRaw: async () => undefined, logger, refreshMs: 2_000 });
  services.push(created);
  return created;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const created of services) created.stop();
  services = [];
  vi.useRealTimers();
});

describe("the model allowlist snapshot", () => {
  it("with no entries, model calls read nothing from the store", async () => {
    const { store, list } = fakeStore([]);
    const allowlist = service(store);
    await allowlist.start();
    expect(list).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 50; index += 1) await allowlist.check(scope("p1"), call(`model-${index}`));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("a failed re-read keeps the last good snapshot and logs", async () => {
    const { store, state } = fakeStore([entry({ modelGlob: "ok" })]);
    const logger = vi.fn();
    const allowlist = service(store, logger);
    await allowlist.start();
    state.fail = true;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("keeping the last copy"), expect.objectContaining({ error: "pool timeout" }));
    await expect(allowlist.check(scope(), call("ok"))).resolves.toBeUndefined();
    await expect(allowlist.check(scope(), call("other"))).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
  });

  it("an empty snapshot keeps allowing every model through read failures", async () => {
    const { store, state } = fakeStore([]);
    const allowlist = service(store);
    await allowlist.start();
    state.fail = true;
    await vi.advanceTimersByTimeAsync(6_100);
    await expect(allowlist.check(scope("p1"), call("anything"))).resolves.toBeUndefined();
  });

  it("fails closed only when no snapshot was ever loaded; a tape report never fails", async () => {
    const { store, state } = fakeStore([entry({})]);
    state.fail = true;
    const allowlist = service(store);
    await allowlist.start();
    await expect(allowlist.check(scope(), call("ok"))).rejects.toBeInstanceOf(ModelAllowlistUnavailableError);
    await expect(allowlist.reportTapeAnswers("p1", [{ nodeId: "llm", providerId: "echo", model: "other" }])).resolves.toEqual([]);
    // Once a read succeeds the calls go through.
    state.fail = false;
    await expect(allowlist.check(scope(), call("ok"))).resolves.toBeUndefined();
  });

  it("a local edit applies to the next call at once", async () => {
    const { store } = fakeStore([]);
    const allowlist = service(store);
    await allowlist.start();
    await allowlist.check(scope("p1"), call("large"));
    const added = await allowlist.add({ scope: "project", projectId: "p1", providerId: "echo", modelGlob: "small" }, "admin@example.com");
    await expect(allowlist.check(scope("p1"), call("large"))).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED", refusedBy: "project" });
    await allowlist.remove(added.id);
    await expect(allowlist.check(scope("p1"), call("large"))).resolves.toBeUndefined();
  });

  it("another instance's edit applies within the re-read interval", async () => {
    const rows: ModelAllowlistEntry[] = [];
    const { store } = fakeStore(rows);
    const allowlist = service(store);
    await allowlist.start();
    // Written by another instance, straight to the shared store.
    rows.push(entry({ modelGlob: "small" }));
    await expect(allowlist.check(scope(), call("large"))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(allowlist.check(scope(), call("large"))).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED", refusedBy: "deployment" });
  });

  it("checks every project a scope names: the provider test's secret's project narrows too", async () => {
    const { store } = fakeStore([entry({ scope: "project", projectId: "p1", modelGlob: "small" })]);
    const allowlist = service(store);
    await allowlist.start();
    await expect(allowlist.check({ projectId: "p2", source: "provider_test" }, call("large"))).resolves.toBeUndefined();
    await expect(allowlist.check({ projectId: "p2", alsoProjectIds: ["p1"], source: "provider_test" }, call("large"))).rejects.toMatchObject({ projectId: "p1" });
  });
});
