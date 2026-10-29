/**
 * Phase 13.1 — store contract: pending challenges, shared rate-limit buckets and replay-capture reservations, on both
 * stores. The app uses them in cluster mode only (Postgres); the contract is the same on SQLite. Lifetimes are judged on
 * the store's clock, so the tests wait for a short lifetime to pass rather than fake a time.
 */
import { expect, it } from "vitest";
import type { PostgresStore } from "../postgres-store.js";
import { ADVISORY_LOCK_CLASS_CAPTURE_RESERVATION } from "../postgres/flow-state.js";
import type { Store } from "../store.js";
import { describeStoreContract } from "../../test-support/test-store.js";

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function challenge(idHash: string, overrides: Partial<Parameters<Store["createPendingChallenge"]>[0]> = {}): Parameters<Store["createPendingChallenge"]>[0] {
  return { idHash, kind: "mfa_login", userId: "u1", scope: null, payloadSealed: `sealed-${idHash}`, ttlMs: 60_000, ...overrides };
}

async function capture(store: Store, workflowId: string, id: string, capturedAt: string): Promise<void> {
  await store.saveReplayRecording({
    id,
    workflowId,
    projectId: null,
    name: `Run ${id}`,
    notes: null,
    sourceExecutionId: `ex-${id}`,
    sourceTriggerType: "webhook",
    sourceStatus: "success",
    workflowHash: "hash-1",
    workflowSavedVersion: 1,
    capturedWorkflowJson: "{}",
    inputJson: "{}",
    nodeOutputsJson: "{}",
    factsJson: "{}",
    mcpCassetteJson: null,
    capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 100,
    truncated: false,
    createdAt: capturedAt,
    createdBy: null,
    status: "candidate",
    capturedAt
  });
}

describeStoreContract("store contract: pending challenges", (ctx) => {
  it("consumes a challenge once, with its fields, and never again", async () => {
    const store = ctx.store();
    await store.createPendingChallenge(challenge("h1", { userId: "u7", scope: "srv-1", payloadSealed: "v1.a.b.c" }));
    const first = await store.consumePendingChallenge({ idHash: "h1", kind: "mfa_login" });
    expect(first).toEqual({ userId: "u7", scope: "srv-1", payloadSealed: "v1.a.b.c", expired: false });
    expect(await store.consumePendingChallenge({ idHash: "h1", kind: "mfa_login" })).toBeNull();
  });

  it("matches the kind: a challenge of another kind is not consumed (and stays)", async () => {
    const store = ctx.store();
    await store.createPendingChallenge(challenge("h2", { kind: "sso_mfa" }));
    expect(await store.consumePendingChallenge({ idHash: "h2", kind: "mfa_login" })).toBeNull();
    expect(await store.consumePendingChallenge({ idHash: "h2", kind: "sso_mfa" })).toMatchObject({ expired: false });
  });

  it("hands out a challenge to exactly one of many concurrent consumers", async () => {
    const store = ctx.store();
    await store.createPendingChallenge(challenge("race", { userId: null }));
    const results = await Promise.all(Array.from({ length: 12 }, () => store.consumePendingChallenge({ idHash: "race", kind: "mfa_login" })));
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("reports an expired challenge as expired (and removes it); the prune removes expired ones only", async () => {
    const store = ctx.store();
    const t0 = Date.now();
    await store.createPendingChallenge(challenge("old", { ttlMs: 20 }));
    await store.createPendingChallenge(challenge("old2", { ttlMs: 20 }));
    await store.createPendingChallenge(challenge("fresh", { ttlMs: 60_000 }));
    // Wait out the 20 ms lifetime with a margin (the store judges it on its own clock).
    await until(() => Date.now() - t0 > 250, "the 20 ms lifetimes to pass");
    expect(await store.consumePendingChallenge({ idHash: "old", kind: "mfa_login" })).toMatchObject({ expired: true });
    expect(await store.prunePendingChallenges()).toBe(1);
    expect(await store.consumePendingChallenge({ idHash: "fresh", kind: "mfa_login" })).toMatchObject({ expired: false });
  });

  it("replaces a challenge stored under the same hash", async () => {
    const store = ctx.store();
    await store.createPendingChallenge(challenge("same", { payloadSealed: "first" }));
    await store.createPendingChallenge(challenge("same", { payloadSealed: "second" }));
    expect(await store.consumePendingChallenge({ idHash: "same", kind: "mfa_login" })).toMatchObject({ payloadSealed: "second" });
  });

  it("deletes by kind, scope and holder (null holder = held for no user)", async () => {
    const store = ctx.store();
    await store.createPendingChallenge(challenge("svc", { kind: "mcp_oauth", scope: "srv", userId: null }));
    await store.createPendingChallenge(challenge("u-a", { kind: "mcp_oauth", scope: "srv", userId: "a" }));
    await store.createPendingChallenge(challenge("u-b", { kind: "mcp_oauth", scope: "srv", userId: "b" }));
    await store.createPendingChallenge(challenge("other", { kind: "mcp_oauth", scope: "srv-2", userId: null }));
    expect(await store.deletePendingChallenges({ kind: "mcp_oauth", scope: "srv", userId: null })).toBe(1);
    expect(await store.deletePendingChallenges({ kind: "mcp_oauth", scope: "srv", userId: "a" })).toBe(1);
    expect(await store.consumePendingChallenge({ idHash: "svc", kind: "mcp_oauth" })).toBeNull();
    expect(await store.consumePendingChallenge({ idHash: "u-a", kind: "mcp_oauth" })).toBeNull();
    expect(await store.consumePendingChallenge({ idHash: "u-b", kind: "mcp_oauth" })).not.toBeNull();
    expect(await store.consumePendingChallenge({ idHash: "other", kind: "mcp_oauth" })).not.toBeNull();
  });
});

describeStoreContract("store contract: shared rate-limit buckets", (ctx) => {
  it("counts hits in a window and reports the time left", async () => {
    const store = ctx.store();
    const first = await store.hitRateLimitBucket({ key: "auth:1.2.3.4", windowMs: 60_000 });
    expect(first.count).toBe(1);
    expect(first.ttlMs).toBeGreaterThan(55_000);
    expect(first.ttlMs).toBeLessThanOrEqual(60_000);
    expect((await store.hitRateLimitBucket({ key: "auth:1.2.3.4", windowMs: 60_000 })).count).toBe(2);
    expect((await store.hitRateLimitBucket({ key: "auth:5.6.7.8", windowMs: 60_000 })).count).toBe(1);
  });

  it("counts every one of many concurrent hits", async () => {
    const store = ctx.store();
    const results = await Promise.all(Array.from({ length: 25 }, () => store.hitRateLimitBucket({ key: "burst", windowMs: 60_000 })));
    expect(results.map((result) => result.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it("starts a new window once the old one has passed, and prunes passed windows", async () => {
    const store = ctx.store();
    await store.hitRateLimitBucket({ key: "roll", windowMs: 30 });
    await store.hitRateLimitBucket({ key: "roll", windowMs: 30 });
    await store.hitRateLimitBucket({ key: "keep", windowMs: 60_000 });
    await until(async () => (await store.hitRateLimitBucket({ key: "roll", windowMs: 30 })).count === 1, "the window to roll over");
    await until(async () => (await store.pruneRateLimitBuckets()) >= 1, "the passed window to be pruned");
    expect((await store.hitRateLimitBucket({ key: "keep", windowMs: 60_000 })).count).toBe(2);
  });
});

describeStoreContract("store contract: replay-capture reservations", (ctx) => {
  it("reserves up to the daily limit, counting stored captures and live reservations", async () => {
    const store = ctx.store();
    const since = new Date(Date.now() - 60_000).toISOString();
    await capture(store, "wf-cap", "rec-1", new Date().toISOString());
    expect(await store.reserveReplayCapture({ id: "r1", workflowId: "wf-cap", since, maxPerDay: 3, ttlMs: 60_000 })).toBe(true);
    expect(await store.reserveReplayCapture({ id: "r2", workflowId: "wf-cap", since, maxPerDay: 3, ttlMs: 60_000 })).toBe(true);
    expect(await store.reserveReplayCapture({ id: "r3", workflowId: "wf-cap", since, maxPerDay: 3, ttlMs: 60_000 })).toBe(false);
    expect(await store.countReplayCaptureReservations("wf-cap")).toBe(2);
    // Another workflow has its own limit.
    expect(await store.reserveReplayCapture({ id: "o1", workflowId: "wf-other", since, maxPerDay: 1, ttlMs: 60_000 })).toBe(true);
    // A released reservation frees its slot; releasing twice or an unknown id is harmless.
    await store.releaseReplayCaptureReservation("r1");
    await store.releaseReplayCaptureReservation("r1");
    await store.releaseReplayCaptureReservation("never");
    expect(await store.reserveReplayCapture({ id: "r4", workflowId: "wf-cap", since, maxPerDay: 3, ttlMs: 60_000 })).toBe(true);
  });

  it("never overshoots the limit under concurrent reservations", async () => {
    const store = ctx.store();
    const since = new Date(Date.now() - 60_000).toISOString();
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => store.reserveReplayCapture({ id: `c${index}`, workflowId: "wf-race", since, maxPerDay: 5, ttlMs: 60_000 }))
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await store.countReplayCaptureReservations("wf-race")).toBe(5);
  });

  it("refuses at once when the day's captures already reach the limit, without waiting for the workflow's lock", async () => {
    const store = ctx.store();
    const since = new Date(Date.now() - 60_000).toISOString();
    await capture(store, "wf-full", "full-1", new Date().toISOString());
    await capture(store, "wf-full", "full-2", new Date().toISOString());
    expect(await store.reserveReplayCapture({ id: "f1", workflowId: "wf-full", since, maxPerDay: 2, ttlMs: 60_000 })).toBe(false);
    if (ctx.kind !== "postgres") return;
    // Another instance holds the workflow's reservation lock: the refusal does not queue behind it.
    const pg = store as PostgresStore;
    const outcome = await pg.withClusterLock(ADVISORY_LOCK_CLASS_CAPTURE_RESERVATION, "wf-full", { waitMs: 0 }, async () => {
      const startedAt = Date.now();
      const admitted = await store.reserveReplayCapture({ id: "f2", workflowId: "wf-full", since, maxPerDay: 2, ttlMs: 60_000 });
      return { admitted, tookMs: Date.now() - startedAt };
    });
    expect(outcome).toMatchObject({ acquired: true, value: { admitted: false } });
    expect(outcome.acquired && outcome.value.tookMs).toBeLessThan(2_000);
    expect(await store.countReplayCaptureReservations("wf-full")).toBe(0);
  });

  it("stops counting an expired reservation, and prunes it", async () => {
    const store = ctx.store();
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await store.reserveReplayCapture({ id: "short", workflowId: "wf-exp", since, maxPerDay: 1, ttlMs: 30 })).toBe(true);
    expect(await store.reserveReplayCapture({ id: "blocked", workflowId: "wf-exp", since, maxPerDay: 1, ttlMs: 60_000 })).toBe(false);
    await until(async () => (await store.countReplayCaptureReservations("wf-exp")) === 0, "the reservation to expire");
    expect(await store.pruneReplayCaptureReservations()).toBe(1);
    expect(await store.reserveReplayCapture({ id: "after", workflowId: "wf-exp", since, maxPerDay: 1, ttlMs: 60_000 })).toBe(true);
  });
});
