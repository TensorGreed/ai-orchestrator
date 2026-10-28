/**
 * Phase 13.1 — cluster-wide session advisory locks (audit export, git sync) across two stores on one database: one
 * holder at a time per key, a try without waiting gives up at once, a waiting caller gets the lock once it is
 * released, keys and classes are independent, and a throwing body still releases. Postgres only.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PostgresStore } from "../postgres-store.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, type TestStore } from "../../test-support/test-store.js";
import { ADVISORY_LOCK_CLASS_AUDIT_EXPORT, ADVISORY_LOCK_CLASS_GIT_SYNC } from "./cluster.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("cluster advisory locks");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

run("cluster advisory locks on Postgres", () => {
  let primary: TestStore | undefined;
  let twin: PostgresStore | undefined;

  afterEach(async () => {
    await twin?.close();
    twin = undefined;
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  it("one holder per key across instances; a try gives up, a wait gets it after the release", async () => {
    primary = await createTestStore({ kind: "postgres" });
    twin = await openTestStoreTwin(primary);
    const a = primary.store as PostgresStore;
    const b = twin;
    const release = deferred();
    const entered = deferred();
    const holding = a.withClusterLock(ADVISORY_LOCK_CLASS_AUDIT_EXPORT, "dest-1", { waitMs: 0 }, async () => {
      entered.resolve();
      await release.promise;
      return "first";
    });
    await entered.promise;
    // Busy for the same key on another instance (and on the same one: each call is its own session).
    expect(await b.withClusterLock(ADVISORY_LOCK_CLASS_AUDIT_EXPORT, "dest-1", { waitMs: 0 }, async () => "no")).toEqual({ acquired: false });
    expect(await a.withClusterLock(ADVISORY_LOCK_CLASS_AUDIT_EXPORT, "dest-1", { waitMs: 0 }, async () => "no")).toEqual({ acquired: false });
    // Another key and another class are free.
    expect(await b.withClusterLock(ADVISORY_LOCK_CLASS_AUDIT_EXPORT, "dest-2", { waitMs: 0 }, async () => "other key")).toEqual({ acquired: true, value: "other key" });
    expect(await b.withClusterLock(ADVISORY_LOCK_CLASS_GIT_SYNC, "dest-1", { waitMs: 0 }, async () => "other class")).toEqual({ acquired: true, value: "other class" });
    // A waiting caller gets it once the holder is done.
    const waiting = b.withClusterLock(ADVISORY_LOCK_CLASS_AUDIT_EXPORT, "dest-1", { waitMs: 10_000, retryMs: 20 }, async () => "second");
    release.resolve();
    expect(await holding).toEqual({ acquired: true, value: "first" });
    expect(await waiting).toEqual({ acquired: true, value: "second" });
  }, 60_000);

  it("releases the lock when the body throws, and gives up after the wait", async () => {
    primary = await createTestStore({ kind: "postgres" });
    const a = primary.store as PostgresStore;
    await expect(a.withClusterLock(ADVISORY_LOCK_CLASS_GIT_SYNC, "git-sync", { waitMs: 0 }, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await a.withClusterLock(ADVISORY_LOCK_CLASS_GIT_SYNC, "git-sync", { waitMs: 0 }, async () => "free")).toEqual({ acquired: true, value: "free" });
    const release = deferred();
    const entered = deferred();
    const holding = a.withClusterLock(ADVISORY_LOCK_CLASS_GIT_SYNC, "git-sync", { waitMs: 0 }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const startedAt = Date.now();
    expect(await a.withClusterLock(ADVISORY_LOCK_CLASS_GIT_SYNC, "git-sync", { waitMs: 150, retryMs: 20 }, async () => "late")).toEqual({ acquired: false });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    release.resolve();
    await holding;
  }, 60_000);
});
