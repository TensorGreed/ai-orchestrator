/**
 * Phase 13.1 — the two ChallengeStore implementations: the in-memory one keeps today's semantics (single use, expiry,
 * per-kind cap with the oldest dropped first); the database one stores only the id's hash and a sealed payload, opens
 * only for the same kind and id, and hands a challenge out once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { challengeIdHash, DbChallengeStore, MemoryChallengeStore } from "./challenge-store.js";
import { SecretService } from "./secret-service.js";
import { createTestStore, type TestStore } from "../test-support/test-store.js";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

describe("MemoryChallengeStore", () => {
  it("hands a challenge out once, with its payload and user", async () => {
    const challenges = new MemoryChallengeStore();
    await challenges.issue({ kind: "mfa_login", id: "c1", userId: "u1", payload: { a: 1 }, ttlMs: 60_000 });
    expect(await challenges.consume("mfa_login", "c1")).toEqual({ payload: { a: 1 }, userId: "u1", expired: false });
    expect(await challenges.consume("mfa_login", "c1")).toBeNull();
  });

  it("keeps kinds apart", async () => {
    const challenges = new MemoryChallengeStore();
    await challenges.issue({ kind: "sso_mfa", id: "c1", userId: "u1", payload: 1, ttlMs: 60_000 });
    expect(await challenges.consume("mfa_login", "c1")).toBeNull();
    expect(await challenges.consume("sso_mfa", "c1")).not.toBeNull();
  });

  it("reports an expired challenge as expired and drops expired ones on the next issue of the kind", async () => {
    let now = 1_000;
    const challenges = new MemoryChallengeStore({ now: () => now });
    await challenges.issue({ kind: "mcp_oauth", id: "old", userId: null, payload: 1, ttlMs: 100 });
    await challenges.issue({ kind: "mcp_oauth", id: "old2", userId: null, payload: 1, ttlMs: 100 });
    now = 1_100;
    expect(await challenges.consume("mcp_oauth", "old")).toMatchObject({ expired: true });
    await challenges.issue({ kind: "mcp_oauth", id: "new", userId: null, payload: 1, ttlMs: 100 });
    expect(await challenges.consume("mcp_oauth", "old2")).toBeNull();
    expect(challenges.size("mcp_oauth")).toBe(1);
  });

  it("drops the oldest of a kind at its cap, not other kinds", async () => {
    const challenges = new MemoryChallengeStore({ maxPerKind: { mcp_oauth: 2 } });
    await challenges.issue({ kind: "mfa_login", id: "m", userId: "u", payload: 1, ttlMs: 60_000 });
    for (const id of ["a", "b", "c"]) await challenges.issue({ kind: "mcp_oauth", id, userId: null, payload: id, ttlMs: 60_000 });
    expect(await challenges.consume("mcp_oauth", "a")).toBeNull();
    expect(await challenges.consume("mcp_oauth", "b")).not.toBeNull();
    expect(await challenges.consume("mcp_oauth", "c")).not.toBeNull();
    expect(await challenges.consume("mfa_login", "m")).not.toBeNull();
  });

  it("discards by scope and holder", async () => {
    const challenges = new MemoryChallengeStore();
    await challenges.issue({ kind: "mcp_oauth", id: "svc", userId: null, scope: "s1", payload: 1, ttlMs: 60_000 });
    await challenges.issue({ kind: "mcp_oauth", id: "usr", userId: "u", scope: "s1", payload: 1, ttlMs: 60_000 });
    await challenges.discard("mcp_oauth", { scope: "s1", userId: null });
    expect(await challenges.consume("mcp_oauth", "svc")).toBeNull();
    expect(await challenges.consume("mcp_oauth", "usr")).not.toBeNull();
  });
});

describe("DbChallengeStore", () => {
  let testStore: TestStore | undefined;
  afterEach(async () => {
    await testStore?.cleanup();
    testStore = undefined;
  });

  async function open() {
    testStore = await createTestStore();
    const secrets = new SecretService(testStore.store, KEY);
    return { store: testStore.store, challenges: new DbChallengeStore(testStore.store, secrets) };
  }

  it("stores the id's hash and a sealed payload only, and hands it out once", async () => {
    const { store, challenges } = await open();
    await challenges.issue({ kind: "mcp_oauth", id: "state-raw", userId: "u1", scope: "srv", payload: { verifier: "pkce-secret-verifier" }, ttlMs: 60_000 });
    // Read the row through the store: only the hash finds it, and the payload is not plain text.
    await challenges.issue({ kind: "mcp_oauth", id: "probe", userId: null, payload: {}, ttlMs: 60_000 });
    expect(await store.consumePendingChallenge({ idHash: "state-raw", kind: "mcp_oauth" })).toBeNull();
    const raw = await store.consumePendingChallenge({ idHash: challengeIdHash("probe"), kind: "mcp_oauth" });
    expect(raw?.payloadSealed.startsWith("v1.")).toBe(true);
    expect(await challenges.consume("mcp_oauth", "state-raw")).toEqual({ payload: { verifier: "pkce-secret-verifier" }, userId: "u1", expired: false });
    expect(await challenges.consume("mcp_oauth", "state-raw")).toBeNull();
  });

  it("refuses a payload moved under another id (the seal binds the kind and the id hash)", async () => {
    const { store, challenges } = await open();
    await challenges.issue({ kind: "mfa_login", id: "victim", userId: "u1", payload: { userId: "u1" }, ttlMs: 60_000 });
    const taken = await store.consumePendingChallenge({ idHash: challengeIdHash("victim"), kind: "mfa_login" });
    await store.createPendingChallenge({ idHash: challengeIdHash("attacker"), kind: "mfa_login", userId: "u1", scope: null, payloadSealed: taken!.payloadSealed, ttlMs: 60_000 });
    expect(await challenges.consume("mfa_login", "attacker")).toBeNull();
  });

  it("discards by scope and holder", async () => {
    const { challenges } = await open();
    await challenges.issue({ kind: "mcp_oauth", id: "svc", userId: null, scope: "s1", payload: 1, ttlMs: 60_000 });
    await challenges.issue({ kind: "mcp_oauth", id: "usr", userId: "u", scope: "s1", payload: 1, ttlMs: 60_000 });
    await challenges.discard("mcp_oauth", { scope: "s1", userId: "u" });
    expect(await challenges.consume("mcp_oauth", "usr")).toBeNull();
    expect(await challenges.consume("mcp_oauth", "svc")).not.toBeNull();
  });
});
