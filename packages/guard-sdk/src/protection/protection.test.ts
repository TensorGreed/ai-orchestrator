import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { luhnValid } from "../detectors/dlp";
import { GuardProtectionError } from "../types";
import { createAesGcmProvider } from "./aes-gcm";
import { createDefaultProtectionRegistry } from "./index";
import { createKeyedHashProvider } from "./keyed-hash";
import { createMaskProvider } from "./mask";
import { createTokenVaultProvider, formatPreservingToken, InMemoryTokenVaultStorage } from "./token-vault";
import { staticKeyResolver } from "./types";

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const keys = staticKeyResolver({ a: keyA, b: keyB, short: randomBytes(8) });

describe("mask provider", () => {
  it("masks by data class and is irreversible", async () => {
    const provider = createMaskProvider();
    expect(await provider.protect("4111 1111 1111 1111", { dataClass: "card_number" })).toBe("•••• •••• •••• 1111");
    expect(await provider.protect("ana@example.org", { dataClass: "email" })).toBe("a••@e••••••.org");
    expect(provider.reversible).toBe(false);
    expect(provider.reveal).toBeUndefined();
  });
});

describe("keyed hash provider", () => {
  it("is deterministic per key and data class, and never reveals", async () => {
    const provider = createKeyedHashProvider({ keys, defaultKeyId: "a" });
    const first = await provider.protect("ana@example.org", { dataClass: "email" });
    expect(first).toMatch(/^ph_email_[0-9a-f]{24}$/);
    expect(await provider.protect("ana@example.org", { dataClass: "email" })).toBe(first);
    expect(await provider.protect("ana@example.org", { dataClass: "email", keyId: "b" })).not.toBe(first);
    expect(await provider.protect("ana@example.org", { dataClass: "national_id" })).not.toBe(first);
    expect(await provider.protect("bob@example.org", { dataClass: "email" })).not.toBe(first);
    expect(provider.reveal).toBeUndefined();
  });

  it("fails on missing or short keys", async () => {
    const provider = createKeyedHashProvider({ keys });
    await expect(provider.protect("x", { dataClass: "email" })).rejects.toBeInstanceOf(GuardProtectionError);
    await expect(provider.protect("x", { dataClass: "email", keyId: "missing" })).rejects.toThrow(/missing/);
    await expect(provider.protect("x", { dataClass: "email", keyId: "short" })).rejects.toThrow(/16 bytes/);
  });
});

describe("aes-gcm provider", () => {
  it("round-trips, is not deterministic and names the key in the token", async () => {
    const provider = createAesGcmProvider({ keys, defaultKeyId: "a" });
    const token = await provider.protect("536-90-4399", { dataClass: "us_ssn" });
    expect(token).toMatch(/^enc:a:[A-Za-z0-9_-]+$/);
    expect(await provider.protect("536-90-4399", { dataClass: "us_ssn" })).not.toBe(token);
    expect(await provider.reveal!(token, { dataClass: "us_ssn" })).toBe("536-90-4399");
  });

  it("fails with the wrong key, the wrong data class or a tampered token", async () => {
    const provider = createAesGcmProvider({ keys, defaultKeyId: "a" });
    const token = await provider.protect("secret value", { dataClass: "credential" });
    const wrongKey = createAesGcmProvider({ keys: staticKeyResolver({ a: keyB }) });
    await expect(wrongKey.reveal!(token, { dataClass: "credential" })).rejects.toThrow(/wrong key/);
    await expect(provider.reveal!(token, { dataClass: "email" })).rejects.toThrow(/wrong key/);
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    await expect(provider.reveal!(tampered, { dataClass: "credential" })).rejects.toBeInstanceOf(GuardProtectionError);
    await expect(provider.reveal!("not-a-token", { dataClass: "credential" })).rejects.toThrow(/not an encrypted value/);
    await expect(createAesGcmProvider({ keys: staticKeyResolver({ a: randomBytes(16) }) }).protect("x", { dataClass: "email", keyId: "a" })).rejects.toThrow(/32 bytes/);
  });
});

describe("token vault provider", () => {
  it("issues random tokens and reveals them from storage", async () => {
    const storage = new InMemoryTokenVaultStorage();
    const provider = createTokenVaultProvider({ storage, random: () => Buffer.alloc(12, 7) });
    const token = await provider.protect("ana@example.org", { dataClass: "email" });
    expect(token).toMatch(/^tok_email_/);
    expect(await provider.reveal!(token, { dataClass: "email" })).toBe("ana@example.org");
    await expect(provider.reveal!(token, { dataClass: "phone" })).rejects.toThrow(/another data class/);
    await expect(provider.reveal!("tok_email_nope", { dataClass: "email" })).rejects.toThrow(/not in the vault/);
    expect(storage.size).toBe(1);
  });

  it("random tokens differ per call; deterministic tokens repeat under a key", async () => {
    const random = createTokenVaultProvider({ storage: new InMemoryTokenVaultStorage() });
    expect(await random.protect("x@example.org", { dataClass: "email" })).not.toBe(await random.protect("x@example.org", { dataClass: "email" }));
    const storage = new InMemoryTokenVaultStorage();
    const deterministic = createTokenVaultProvider({ storage, keys, defaultKeyId: "a", deterministic: true });
    const first = await deterministic.protect("x@example.org", { dataClass: "email" });
    expect(await deterministic.protect("x@example.org", { dataClass: "email" })).toBe(first);
    expect(storage.size).toBe(1);
    expect(await deterministic.reveal!(first, { dataClass: "email" })).toBe("x@example.org");
    await expect(createTokenVaultProvider({ storage, deterministic: true }).protect("x", { dataClass: "email" })).rejects.toThrow(/key resolver/);
  });

  it("preserves format for digit-bearing classes and keeps cards Luhn-valid", async () => {
    let n = 0;
    const digits = () => (n += 3) % 10;
    const fp = formatPreservingToken("4111 1111 1111 1111", "card_number", digits);
    expect(fp).toMatch(/^4\d{3} \d{4} \d{4} \d{4}$/);
    expect(fp).not.toBe("4111 1111 1111 1111");
    expect(luhnValid(fp)).toBe(true);
    expect(formatPreservingToken("536-90-4399", "us_ssn", digits)).toMatch(/^\d{3}-\d{2}-\d{4}$/);
    expect(formatPreservingToken("no digits", "email", digits)).toBe("no digits");
    const provider = createTokenVaultProvider({ storage: new InMemoryTokenVaultStorage(), formatPreserving: true });
    const token = await provider.protect("4111 1111 1111 1111", { dataClass: "card_number" });
    expect(luhnValid(token)).toBe(true);
    expect(await provider.reveal!(token, { dataClass: "card_number" })).toBe("4111 1111 1111 1111");
    const plain = await provider.protect("ana@example.org", { dataClass: "email" });
    expect(plain).toMatch(/^tok_email_/);
  });
});

describe("default protection registry", () => {
  it("registers the five built-in providers and resolves by data class", () => {
    const registry = createDefaultProtectionRegistry({ keys, defaultKeyId: "a" });
    expect(registry.list().map((p) => p.id).sort()).toEqual(["aes_gcm", "keyed_hash", "mask", "surrogate", "token_vault"]);
    expect(registry.resolve("mask", "email").id).toBe("mask");
    expect(() => registry.resolve("nope", "email")).toThrow(GuardProtectionError);
    registry.replace({ id: "mask", description: "", deterministic: true, reversible: false, dataClasses: ["email"], protect: async () => "x" });
    expect(() => registry.resolve("mask", "phone")).toThrow(/does not cover/);
  });
});
