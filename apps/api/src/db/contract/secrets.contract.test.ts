/**
 * Phase 13.1 — store contract: secrets (ciphertext only), secret shares, external secret providers and their cache.
 * The same assertions run on SQLite and, with TEST_POSTGRES_URL, on Postgres.
 */
import { expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function secret(store: Store, id: string, extra: Partial<Parameters<Store["saveSecret"]>[0]> = {}) {
  await store.saveSecret({ id, name: `Secret ${id}`, provider: "openai", iv: `iv-${id}`, authTag: `tag-${id}`, ciphertext: `ct-${id}`, ...extra });
}

describeStoreContract("store contract: secrets", (ctx) => {
  it("saves, reads and lists secrets newest first, filtered by project; external fields round-trip", async () => {
    const store = ctx.store();
    await secret(store, "s1");
    await tick();
    await secret(store, "s2", { projectId: "p1", source: "external", externalProviderId: "prov", externalKey: "path/key" });
    const s1 = await store.getSecret("s1");
    expect(s1).toEqual({
      id: "s1",
      name: "Secret s1",
      provider: "openai",
      iv: "iv-s1",
      auth_tag: "tag-s1",
      ciphertext: "ct-s1",
      created_at: s1?.created_at,
      project_id: DEFAULT_PROJECT_ID,
      projectId: DEFAULT_PROJECT_ID,
      source: "local",
      externalProviderId: null,
      externalKey: null
    });
    expect(s1?.created_at).toMatch(ISO);
    expect(await store.getSecret("s2")).toMatchObject({ projectId: "p1", source: "external", externalProviderId: "prov", externalKey: "path/key" });
    expect(await store.getSecret("missing")).toBeNull();

    const listed = await store.listSecrets();
    expect(listed.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(listed[0]).not.toHaveProperty("ciphertext");
    expect(listed[1]).toEqual({ id: "s1", name: "Secret s1", provider: "openai", created_at: s1?.created_at, projectId: DEFAULT_PROJECT_ID, source: "local", externalProviderId: null, externalKey: null });
    expect((await store.listSecrets({ projectId: DEFAULT_PROJECT_ID })).map((s) => s.id)).toEqual(["s1"]);
    expect((await store.listSecrets({ projectId: "p1" })).map((s) => s.id)).toEqual(["s2"]);

    await secret(store, "s2", { name: "Renamed", ciphertext: "ct-new" });
    expect(await store.getSecret("s2")).toMatchObject({ name: "Renamed", ciphertext: "ct-new", projectId: DEFAULT_PROJECT_ID, source: "local", externalProviderId: null });
    expect(await store.countSecretsUsingExternalProvider("prov")).toBe(0);
  });

  it("deleteSecret removes the secret with its shares and cache entry, once", async () => {
    const store = ctx.store();
    await secret(store, "s1");
    await store.upsertSecretShare({ secretId: "s1", projectId: "p1" });
    await store.upsertExternalSecretCacheEntry({ secretId: "s1", iv: "i", authTag: "t", ciphertext: "c", expiresAt: new Date(Date.now() + 1000).toISOString() });
    expect(await store.deleteSecret("s1")).toBe(true);
    expect(await store.getSecret("s1")).toBeNull();
    expect(await store.listSecretShares("s1")).toEqual([]);
    expect(await store.listSecretsSharedToProject("p1")).toEqual([]);
    expect(await store.getExternalSecretCacheEntry("s1")).toBeNull();
    expect(await store.deleteSecret("s1")).toBe(false);
  });

  it("secret shares: an upsert of an existing share changes nothing; lists by secret and by project; remove once", async () => {
    const store = ctx.store();
    await secret(store, "s1");
    await secret(store, "s2");
    await store.upsertSecretShare({ secretId: "s1", projectId: "pb", sharedBy: "u1" });
    await store.upsertSecretShare({ secretId: "s1", projectId: "PA" });
    await tick();
    await store.upsertSecretShare({ secretId: "s2", projectId: "pb" });
    const shares = await store.listSecretShares("s1");
    expect(shares.map((s) => s.projectId)).toEqual(["PA", "pb"]);
    expect(shares[1]).toMatchObject({ secretId: "s1", projectId: "pb", sharedBy: "u1" });
    expect(shares[0].sharedBy).toBeNull();
    expect(shares[1].createdAt).toMatch(ISO);
    await store.upsertSecretShare({ secretId: "s1", projectId: "pb", sharedBy: "u2" });
    expect((await store.listSecretShares("s1"))[1]).toEqual(shares[1]);
    expect(await store.listSecretsSharedToProject("pb")).toEqual(["s1", "s2"]);
    expect(await store.removeSecretShare("s1", "pb")).toBe(true);
    expect(await store.removeSecretShare("s1", "pb")).toBe(false);
    expect(await store.listSecretsSharedToProject("pb")).toEqual(["s2"]);
  });

  it("external secret providers: defaults, upsert keeps creation time and author, list newest first, count users, delete once", async () => {
    const store = ctx.store();
    await store.upsertExternalSecretProvider({ id: "v1", name: "Vault", type: "vault", config: { url: "https://vault" }, createdBy: "u1" });
    await tick();
    await store.upsertExternalSecretProvider({ id: "a1", name: "AWS", type: "aws", config: {}, credentialsSecretId: "cred", cacheTtlMs: 1000, enabled: false });
    const v1 = await store.getExternalSecretProvider("v1");
    expect(v1).toEqual({
      id: "v1",
      name: "Vault",
      type: "vault",
      config: { url: "https://vault" },
      credentialsSecretId: null,
      cacheTtlMs: 300000,
      enabled: true,
      createdBy: "u1",
      createdAt: v1?.createdAt,
      updatedAt: v1?.updatedAt
    });
    expect(v1?.createdAt).toMatch(ISO);
    expect(await store.getExternalSecretProvider("a1")).toMatchObject({ credentialsSecretId: "cred", cacheTtlMs: 1000, enabled: false, createdBy: null });
    expect((await store.listExternalSecretProviders()).map((p) => p.id)).toEqual(["a1", "v1"]);
    expect(await store.getExternalSecretProvider("missing")).toBeNull();

    await tick();
    await store.upsertExternalSecretProvider({ id: "v1", name: "Vault 2", type: "vault", config: { url: "https://v2" }, createdBy: "u9", enabled: false });
    const updated = await store.getExternalSecretProvider("v1");
    expect(updated).toMatchObject({ name: "Vault 2", config: { url: "https://v2" }, enabled: false, createdBy: "u1", createdAt: v1?.createdAt });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(v1!.updatedAt));

    await secret(store, "e1", { source: "external", externalProviderId: "v1", externalKey: "k1" });
    await secret(store, "e2", { source: "external", externalProviderId: "v1", externalKey: "k2" });
    expect(await store.countSecretsUsingExternalProvider("v1")).toBe(2);
    expect(await store.countSecretsUsingExternalProvider("a1")).toBe(0);

    expect(await store.deleteExternalSecretProvider("a1")).toBe(true);
    expect(await store.deleteExternalSecretProvider("a1")).toBe(false);
  });

  it("external secret cache: upsert replaces the entry and its fetch time; delete is idempotent", async () => {
    const store = ctx.store();
    expect(await store.getExternalSecretCacheEntry("s1")).toBeNull();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await store.upsertExternalSecretCacheEntry({ secretId: "s1", iv: "i1", authTag: "t1", ciphertext: "c1", expiresAt });
    const first = await store.getExternalSecretCacheEntry("s1");
    expect(first).toEqual({ secretId: "s1", iv: "i1", authTag: "t1", ciphertext: "c1", fetchedAt: first?.fetchedAt, expiresAt });
    expect(first?.fetchedAt).toMatch(ISO);
    await tick();
    await store.upsertExternalSecretCacheEntry({ secretId: "s1", iv: "i2", authTag: "t2", ciphertext: "c2", expiresAt });
    const second = await store.getExternalSecretCacheEntry("s1");
    expect(second).toMatchObject({ iv: "i2", authTag: "t2", ciphertext: "c2" });
    expect(Date.parse(second!.fetchedAt)).toBeGreaterThan(Date.parse(first!.fetchedAt));
    await store.deleteExternalSecretCacheEntry("s1");
    await store.deleteExternalSecretCacheEntry("s1");
    expect(await store.getExternalSecretCacheEntry("s1")).toBeNull();
  });
});
