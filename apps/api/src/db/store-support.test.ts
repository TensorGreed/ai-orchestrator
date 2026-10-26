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

  it("treats any other store as implementing everything", () => {
    expect(storeImplements({} as Store, "listEvalRuns")).toBe(true);
  });
});
