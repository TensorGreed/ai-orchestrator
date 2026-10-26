import { describe, expect, it } from "vitest";
import { PostgresStore } from "./postgres-store.js";
import { storeImplements } from "./store-support.js";
import type { Store } from "./store.js";

describe("storeImplements", () => {
  it("lists exactly the Postgres methods that throw StoreNotImplementedError: none, now that every domain is ported", () => {
    const pg = Object.create(PostgresStore.prototype) as Store;
    expect([...PostgresStore.unimplemented]).toEqual([]);
    for (const method of ["getWorkflow", "appendWorkflowVersion", "listMcpServers", "anyGuardProfileUsesLabels", "listEvalRuns", "recordBudgetAlert"] as const) {
      expect(storeImplements(pg, method)).toBe(true);
      expect(typeof (PostgresStore.prototype as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("answers false for a method a Postgres store lists as unimplemented, true for the rest", () => {
    // Synthetic: no real method is unimplemented any more, but the false branch gates the 501 routes and mayUseLabels.
    // A PostgresStore whose class lists two methods (the constructor is private, so the class is stood in for).
    const unimplemented: ReadonlySet<keyof Store> = new Set<keyof Store>(["listEvalRuns", "anyGuardProfileUsesLabels"]);
    const partialPrototype = Object.create(PostgresStore.prototype, { constructor: { value: { unimplemented } } }) as object;
    const partial = Object.create(partialPrototype) as Store;
    expect(storeImplements(partial, "listEvalRuns")).toBe(false);
    expect(storeImplements(partial, "anyGuardProfileUsesLabels")).toBe(false);
    expect(storeImplements(partial, "getWorkflow")).toBe(true);
    expect(storeImplements(Object.create(PostgresStore.prototype) as Store, "listEvalRuns")).toBe(true);
  });

  it("treats any other store as implementing everything", () => {
    expect(storeImplements({} as Store, "listEvalRuns")).toBe(true);
  });
});
