/**
 * Phase 13.1 — PgContext maps U+0000 to U+FFFD in every string parameter, on every query path a module can use.
 */
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { Store } from "../store.js";
import { createPgContext, pgParams, pgText } from "./context.js";

function fakePool() {
  const calls: unknown[][] = [];
  let released = 0;
  const client = {
    query: async (...args: unknown[]) => {
      calls.push(["client", ...args]);
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released += 1;
    }
  };
  const pool = {
    totalCount: 3,
    query: async (...args: unknown[]) => {
      calls.push(["pool", ...args]);
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    connect: async () => client,
    end: async () => undefined
  };
  return { pool: pool as unknown as Pool, calls, released: () => released };
}

describe("PgContext NUL mapping", () => {
  it("pgText replaces every NUL and leaves other values alone", () => {
    expect(pgText("a\u0000b\u0000")).toBe("a�b�");
    expect(pgText("plain")).toBe("plain");
    expect(pgText(null)).toBeNull();
    expect(pgText(5)).toBe(5);
    const buffer = Buffer.from([0, 1]);
    expect(pgParams(["\u0000", ["x\u0000", 1], buffer, { a: "\u0000" }, null])).toEqual(["�", ["x�", 1], buffer, { a: "\u0000" }, null]);
    expect(pgParams(undefined)).toBeUndefined();
  });

  it("maps query, queryOne, execute, pool.query (text and config forms), pool.connect, withClient and withTransaction", async () => {
    const fake = fakePool();
    const ctx = createPgContext(fake.pool, {} as Store);
    await ctx.query("q1", ["a\u0000"]);
    expect(await ctx.queryOne("q2", ["b\u0000"])).toEqual({ ok: 1 });
    await ctx.execute("q3", ["c\u0000"]);
    await ctx.pool.query("q4", ["d\u0000"]);
    await ctx.pool.query({ text: "q5", values: ["e\u0000"] });
    await ctx.pool.query("q6");
    const client = await ctx.pool.connect();
    await client.query("q7", ["f\u0000"]);
    client.release();
    await ctx.withClient((c) => c.query("q8", ["g\u0000"]));
    await ctx.withTransaction((c) => c.query({ text: "q9", values: [["h\u0000"]] }));
    expect(fake.calls).toEqual([
      ["pool", "q1", ["a�"]],
      ["pool", "q2", ["b�"]],
      ["pool", "q3", ["c�"]],
      ["pool", "q4", ["d�"]],
      ["pool", { text: "q5", values: ["e�"] }],
      ["pool", "q6"],
      ["client", "q7", ["f�"]],
      ["client", "q8", ["g�"]],
      ["client", "BEGIN"],
      ["client", { text: "q9", values: [["h�"]] }],
      ["client", "COMMIT"]
    ]);
    expect(fake.released()).toBe(3);
    expect(ctx.pool.totalCount).toBe(3);
  });
});
