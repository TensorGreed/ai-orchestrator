import { describe, expect, it } from "vitest";
import { createAesGcmProvider } from "./aes-gcm";
import { revealTokenHash, revealTokens, vaultTokenPattern, type RevealGrant, type RevealTokensOptions } from "./reveal";
import { createTokenVaultProvider, InMemoryTokenVaultStorage } from "./token-vault";

const KEY = Buffer.alloc(32, 7);
const keys = async (id: string) => (id === "k1" ? KEY : undefined);
const rule = (index: number, requireApproval = false): RevealGrant => ({ rule: { profileId: "p", version: 1, index }, ...(requireApproval ? { requireApproval } : {}) });

function options(storage: InMemoryTokenVaultStorage, overrides: Partial<RevealTokensOptions> = {}): RevealTokensOptions {
  const allowed = new Set(overrides.allowedClasses ?? ["card_number", "email"]);
  return {
    vault: storage,
    keys,
    allowedKeyIds: ["k1"],
    allowedClasses: [...allowed],
    grant: (dataClass) => (allowed.has(dataClass) ? rule(0) : undefined),
    projectId: "proj-a",
    allowUnscoped: false,
    ...overrides
  };
}

describe("revealTokens", () => {
  it("finds vault tokens by shape, including classes with underscores, and leaves other text alone", () => {
    const text = "a tok_card_number_AbC-_12345678901 b tok_email_xyzXYZ0123456789x c tok_short_123";
    expect([...text.matchAll(vaultTokenPattern())].map((match) => match[0])).toEqual(["tok_card_number_AbC-_12345678901"]);
  });

  it("reveals vault tokens of allowed classes in nested content and reports counts and hashes, never values", async () => {
    const storage = new InMemoryTokenVaultStorage();
    const vault = createTokenVaultProvider({ storage });
    const card = await vault.protect("4111 1111 1111 1111", { dataClass: "card_number" });
    const ssn = await vault.protect("123-45-6789", { dataClass: "us_ssn" });
    for (const record of [card, ssn]) await storage.put({ ...(await storage.getByToken(record))!, projectId: "proj-a" });
    const result = await revealTokens({ rows: [`card ${card}`, { id: ssn }], again: card, n: 3 }, options(storage));
    expect(result.content).toEqual({ rows: ["card 4111 1111 1111 1111", { id: ssn }], again: "4111 1111 1111 1111", n: 3 });
    expect(result.revealed).toEqual([{ dataClass: "card_number", count: 2, tokenHashes: [revealTokenHash(card)], rule: { profileId: "p", version: 1, index: 0 } }]);
    expect(result.refused).toEqual([{ dataClass: "us_ssn", count: 1, tokenHashes: [revealTokenHash(ssn)], reason: "no_rule" }]);
    expect(result.revealedClasses).toEqual(["card_number"]);
    expect(JSON.stringify([result.revealed, result.refused])).not.toContain("4111");
    expect(JSON.stringify([result.revealed, result.refused])).not.toContain(card);
  });

  it("refuses another project's tokens, unscoped tokens unless allowed, and unknown tokens", async () => {
    const storage = new InMemoryTokenVaultStorage();
    const at = new Date().toISOString();
    await storage.put({ token: "tok_email_AAAAAAAAAAAAAAAA", dataClass: "email", value: "a@example.org", createdAt: at, projectId: "proj-b" });
    await storage.put({ token: "tok_email_BBBBBBBBBBBBBBBB", dataClass: "email", value: "b@example.org", createdAt: at });
    const text = "tok_email_AAAAAAAAAAAAAAAA tok_email_BBBBBBBBBBBBBBBB tok_email_CCCCCCCCCCCCCCCC";
    const denied = await revealTokens(text, options(storage));
    expect(denied.content).toBe(text);
    expect(denied.refused.map((entry) => [entry.dataClass ?? null, entry.reason])).toEqual([
      [null, "unknown_token"],
      ["email", "other_project"],
      ["email", "unscoped_token"]
    ]);
    const admin = await revealTokens(text, options(storage, { allowUnscoped: true }));
    expect(admin.content).toBe("tok_email_AAAAAAAAAAAAAAAA b@example.org tok_email_CCCCCCCCCCCCCCCC");
  });

  it("opens encrypted values only under listed keys and allowed classes (the class is bound into the ciphertext)", async () => {
    const aes = createAesGcmProvider({ keys });
    const email = await aes.protect("c@example.org", { dataClass: "email", keyId: "k1" });
    const iban = await aes.protect("DE89370400440532013000", { dataClass: "iban", keyId: "k1" });
    const storage = new InMemoryTokenVaultStorage();
    const result = await revealTokens(`${email} / ${iban}`, options(storage));
    expect(result.content).toBe(`c@example.org / ${iban}`);
    expect(result.refused).toEqual([expect.objectContaining({ reason: "not_decryptable", count: 1 })]);
    const unlisted = await revealTokens(email, options(storage, { allowedKeyIds: [] }));
    expect(unlisted.content).toBe(email);
    expect(unlisted.refused[0]?.reason).toBe("key_not_allowed");
  });

  it("finds format-preserving vault tokens through the data detectors of the classes asked for, and ignores real values", async () => {
    const storage = new InMemoryTokenVaultStorage();
    const vault = createTokenVaultProvider({ storage, formatPreserving: true });
    const token = await vault.protect("4111 1111 1111 1111", { dataClass: "card_number" });
    await storage.put({ ...(await storage.getByToken(token))!, projectId: "proj-a" });
    const text = `token ${token}, real 5555 5555 5555 4444`;
    expect((await revealTokens(text, options(storage))).content).toBe(text);
    const result = await revealTokens(text, options(storage, { formatPreservingClasses: ["card_number"] }));
    expect(result.content).toBe("token 4111 1111 1111 1111, real 5555 5555 5555 4444");
    expect(result.refused).toEqual([]);
  });

  it("collects the hashes of tokens whose rule asks for approval", async () => {
    const storage = new InMemoryTokenVaultStorage();
    const at = new Date().toISOString();
    await storage.put({ token: "tok_card_number_AAAAAAAAAAAAAAAA", dataClass: "card_number", value: "4111 1111 1111 1111", createdAt: at, projectId: "proj-a" });
    await storage.put({ token: "tok_email_AAAAAAAAAAAAAAAA", dataClass: "email", value: "a@example.org", createdAt: at, projectId: "proj-a" });
    const result = await revealTokens("tok_card_number_AAAAAAAAAAAAAAAA tok_email_AAAAAAAAAAAAAAAA", {
      ...options(storage),
      grant: (dataClass) => rule(0, dataClass === "card_number")
    });
    expect(result.approvalTokenHashes).toEqual([revealTokenHash("tok_card_number_AAAAAAAAAAAAAAAA")]);
  });

  it("caps the distinct tokens one call looks at", async () => {
    const storage = new InMemoryTokenVaultStorage();
    const text = Array.from({ length: 3 }, (_, index) => `tok_email_${String(index).padStart(16, "A")}`).join(" ");
    await expect(revealTokens(text, options(storage, { maxTokens: 2 }))).rejects.toThrow(/More than 2 distinct tokens/);
  });
});
