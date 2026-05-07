import { describe, it, expect } from "vitest";
import { MIGRATIONS, runMigrations, rollbackMigrations } from "./migrations.js";

/**
 * Round-trip test for the rollback framework. Uses an in-memory mock store
 * that tracks (a) the applied SQL string, (b) the current version. We don't
 * need a real database here — the framework's job is to walk the migration
 * graph in the right order and call the right callbacks. Postgres-specific
 * SQL syntax is verified separately by integration tests.
 */
function makeMockStore() {
  const applied: Array<{ direction: "up" | "down"; version: number; sql: string }> = [];
  let currentVersion = 0;

  return {
    applied,
    async runSql(sql: string) {
      // Direction is inferred by comparing against the next/prev migration's
      // up/down — captured here just as raw SQL for assertion purposes.
      applied.push({
        direction: sql.includes("DROP") && !sql.includes("CREATE") ? "down" : "up",
        version: -1,
        sql: sql.trim()
      });
    },
    async getCurrentVersion() {
      return currentVersion;
    },
    async setVersion(version: number) {
      currentVersion = version;
    },
    get version() {
      return currentVersion;
    }
  };
}

describe("rollbackMigrations", () => {
  it("every migration declares a non-empty `down`", () => {
    for (const m of MIGRATIONS) {
      expect(m.down, `migration v${m.version} (${m.description}) is missing down SQL`).toBeTruthy();
      expect(m.down.trim().length, `migration v${m.version} has empty down`).toBeGreaterThan(0);
    }
  });

  it("is a no-op when current version is already at or below target", async () => {
    const store = makeMockStore();
    await store.setVersion(5);
    const result = await rollbackMigrations(
      store.runSql.bind(store),
      store.getCurrentVersion.bind(store),
      store.setVersion.bind(store),
      5
    );
    expect(result.rolledBack).toEqual([]);
    expect(result.from).toBe(5);
    expect(result.to).toBe(5);
    expect(store.version).toBe(5);
    expect(store.applied).toEqual([]);
  });

  it("rolls back in reverse version order", async () => {
    const store = makeMockStore();
    await store.setVersion(13);
    const result = await rollbackMigrations(
      store.runSql.bind(store),
      store.getCurrentVersion.bind(store),
      store.setVersion.bind(store),
      10
    );
    expect(result.rolledBack).toEqual([13, 12, 11]);
    expect(result.from).toBe(13);
    expect(result.to).toBe(10);
    expect(store.version).toBe(10);
  });

  it("round-trips: apply all -> roll back to 0 -> reapply all", async () => {
    const store = makeMockStore();
    const max = MIGRATIONS.reduce((acc, m) => Math.max(acc, m.version), 0);

    await runMigrations(
      store.runSql.bind(store),
      store.getCurrentVersion.bind(store),
      store.setVersion.bind(store)
    );
    expect(store.version).toBe(max);

    const rollback = await rollbackMigrations(
      store.runSql.bind(store),
      store.getCurrentVersion.bind(store),
      store.setVersion.bind(store),
      0
    );
    expect(rollback.rolledBack.length).toBe(MIGRATIONS.length);
    expect(store.version).toBe(0);

    await runMigrations(
      store.runSql.bind(store),
      store.getCurrentVersion.bind(store),
      store.setVersion.bind(store)
    );
    expect(store.version).toBe(max);
  });

  it("rejects negative target versions", async () => {
    const store = makeMockStore();
    await expect(
      rollbackMigrations(
        store.runSql.bind(store),
        store.getCurrentVersion.bind(store),
        store.setVersion.bind(store),
        -1
      )
    ).rejects.toThrow(/targetVersion must be >= 0/);
  });

  it("refuses to roll back partially when a `down` is missing", async () => {
    const store = makeMockStore();
    await store.setVersion(13);

    const orig = MIGRATIONS.find((m) => m.version === 12)!;
    const savedDown = orig.down;
    (orig as { down: string }).down = "";

    try {
      await expect(
        rollbackMigrations(
          store.runSql.bind(store),
          store.getCurrentVersion.bind(store),
          store.setVersion.bind(store),
          10
        )
      ).rejects.toThrow(/has no `down` SQL/);
      // Nothing should have been applied since validation runs before any SQL.
      expect(store.applied).toEqual([]);
      expect(store.version).toBe(13);
    } finally {
      (orig as { down: string }).down = savedDown;
    }
  });
});
