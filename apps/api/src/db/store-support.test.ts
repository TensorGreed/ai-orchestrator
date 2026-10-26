import { describe, expect, it } from "vitest";
import { PostgresStore } from "./postgres-store.js";
import { StoreNotImplementedError } from "./store-errors.js";
import { storeImplements } from "./store-support.js";
import type { Store } from "./store.js";

describe("storeImplements", () => {
  it("lists exactly the Postgres methods that throw StoreNotImplementedError", async () => {
    const pg = Object.create(PostgresStore.prototype) as Store;
    expect(PostgresStore.unimplemented.size).toBeGreaterThan(0);
    for (const method of PostgresStore.unimplemented) {
      expect(storeImplements(pg, method)).toBe(false);
      const fn = (pg as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!;
      await expect(fn.call(pg)).rejects.toBeInstanceOf(StoreNotImplementedError);
    }
    expect(storeImplements(pg, "getWorkflow")).toBe(true);
  });

  it("treats any other store as implementing everything", () => {
    expect(storeImplements({} as Store, "listEvalRuns")).toBe(true);
  });
});
